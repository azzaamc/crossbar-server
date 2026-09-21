'use strict';

// The signalling server: Engine.IO v4 over a raw WebSocket, with the Socket.IO v5
// message layer reduced to the subset both Crossbar clients speak.
//
// Two things are deliberately different from the implementation this replaces.
//
// 1. Admission is an authorization decision. A socket is authenticated by the same
//    injected identity the API uses — a WebSocket upgrade is an HTTP request
//    through the same proxy, so it carries the same header — and may only join a
//    call it is actually a participant of. Knowing a room name is worth nothing.
//
// 2. Relay is participant-scoped. A peer may address another peer of its own call
//    and nobody else. The previous server routed through a global socket registry
//    with no membership check at all, which let any socket inject SDP or ICE into
//    any other socket on the host.
//
// Everything is in memory. There is nothing here worth persisting: a room is a view
// of who is connected, and the call it belongs to outlives it in the database.

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const machine = require('./calls');
const { resolveIdentity } = require('./identity');
const auth = require('./auth');
const { iceConfigFor } = require('./ice');
const validate = require('./validate');

const ENGINE_OPEN = '0';
const ENGINE_PING = '2';
const ENGINE_PONG = '3';
const ENGINE_MESSAGE = '4';

const CLOSE_MALFORMED = 1008;
const CLOSE_TOO_MANY = 1009;

function createSignalServer({ config, store, log, onAdmitted, onClosed }) {
    const rooms = new Map(); // roomId -> Map(peerId -> session)
    const sessions = new Map(); // peerId -> session, admitted only
    const connections = new Set(); // every open socket, admitted or not
    const wss = new WebSocketServer({
        noServer: true,
        maxPayload: config.messageBytes,
        perMessageDeflate: false,
    });

    let heartbeat = null;
    let closed = false;

    // ── Framing ─────────────────────────────────────────────────────────────────

    function raw(session, text) {
        if (session.ws.readyState !== session.ws.OPEN) return;
        session.ws.send(text);
    }

    function emit(session, name, payload) {
        raw(session, `42${JSON.stringify([name, payload])}`);
    }

    function refuse(session, reason, detail = {}) {
        log.warn('signal_rejected', {
            peerId: session.id,
            reason,
            callId: session.callId,
            room: session.room,
            ...detail,
        });
        emit(session, 'unauthorized', { reason });
    }

    // ── Rate limiting ───────────────────────────────────────────────────────────

    function take(session, bucket, limit) {
        const now = Date.now();
        const windowStart = now - 1000;
        const recent = session.buckets[bucket].filter((value) => value > windowStart);
        if (recent.length >= limit) {
            session.buckets[bucket] = recent;
            return false;
        }
        recent.push(now);
        session.buckets[bucket] = recent;
        return true;
    }

    function malformed(session, reason) {
        session.malformedCount += 1;
        log.warn('signal_malformed', { peerId: session.id, reason, count: session.malformedCount });
        if (session.malformedCount >= config.malformedLimit) {
            session.ws.close(CLOSE_MALFORMED, 'too many invalid messages');
        }
    }

    // ── Room bookkeeping ────────────────────────────────────────────────────────

    function roomFor(roomId, create = false) {
        let room = rooms.get(roomId);
        if (!room && create) {
            room = new Map();
            rooms.set(roomId, room);
        }
        return room;
    }

    function addPeer(session) {
        roomFor(session.room, true).set(session.id, session);
        sessions.set(session.id, session);
    }

    function removePeer(session) {
        session.departed = true;
        const room = rooms.get(session.room);
        if (room) {
            room.delete(session.id);
            if (room.size === 0) rooms.delete(session.room);
        }
        sessions.delete(session.id);
    }

    /** One `addPeer` per pair, with the joiner as the offerer on every new pair. */
    function fanOutJoin(session) {
        const room = rooms.get(session.room);
        if (!room) return;
        for (const peer of room.values()) {
            if (peer === session) continue;
            emit(peer, 'addPeer', {
                peer_id: session.id,
                should_create_offer: false,
                peer_name: session.peerName,
                // Each side is told what *it* may use, not what the other side may:
                // a relay credential belongs to the device it was issued to.
                iceServers: peer.ice || config.iceServers,
            });
            emit(session, 'addPeer', {
                peer_id: peer.id,
                should_create_offer: true,
                peer_name: peer.peerName,
                iceServers: session.ice || config.iceServers,
            });
        }
    }

    function announceDeparture(session) {
        const room = rooms.get(session.room);
        if (!room) return;
        for (const peer of room.values()) {
            if (peer === session) continue;
            emit(peer, 'removePeer', { peer_id: session.id });
        }
    }

    /**
     * A device that reconnects gets a new connection id, so its previous one has to
     * go — otherwise the room holds two of the same person and every other peer
     * negotiates with a ghost. The old connection is closed after the new one is in
     * place, so the far end sees one departure and one arrival, in that order.
     */
    function evictPreviousSessions(session) {
        const room = rooms.get(session.room);
        if (!room) return;
        for (const peer of [...room.values()]) {
            if (peer === session) continue;
            const sameDevice = session.deviceId && peer.deviceId === session.deviceId;
            const sameIdentity = !session.deviceId && peer.userId === session.userId
                && peer.peerUuid === session.peerUuid;
            if (!sameDevice && !sameIdentity) continue;
            log.info('signal_evicted', {
                peerId: peer.id,
                replacedBy: session.id,
                callId: session.callId,
                reason: sameDevice ? 'same_device_reconnected' : 'same_client_rejoined',
            });
            removePeer(peer);
            announceDeparture(peer);
            peer.ws.close(1000, 'replaced by a newer connection');
            if (onClosed) onClosed(peer, 'evicted');
        }
    }

    // ── Events ──────────────────────────────────────────────────────────────────

    function handleJoin(session, payload) {
        if (!session.namespaceConnected) return malformed(session, 'join_before_connect');
        if (session.admitted) return refuse(session, 'already_joined');

        if (!session.identity) return refuse(session, 'no_identity');
        const user = userForIdentity(session.identity);
        if (!user) return refuse(session, 'not_enrolled');

        let joined;
        try {
            joined = validate.validateJoin(payload);
        } catch (error) {
            return refuse(session, error.reason || 'invalid_join');
        }

        const call = store.callByRoom(joined.channel);
        if (!call) return refuse(session, 'room_not_found');

        const participant = store.participant(call.id, user.id);
        const refusal = machine.joinRefusal(call, participant);
        if (refusal) return refuse(session, refusal);

        const deviceId = session.deviceId;
        const now = new Date().toISOString();

        session.callId = call.id;
        session.room = joined.channel;
        session.userId = user.id;
        session.peerName = user.displayName;
        session.peerUuid = joined.peerUuid;
        session.peerAvatar = joined.peerAvatar;
        session.media = {
            video: joined.videoStatus,
            audio: joined.audioStatus,
            screen: joined.screenStatus,
        };

        // Any earlier connection for this same device is taken out first, so a
        // reconnect cannot be refused for being full of itself, and so the other
        // participants see one departure before one arrival.
        evictPreviousSessions(session);

        const room = roomFor(joined.channel, true);
        if (room.size >= config.maxParticipants) return refuse(session, 'room_full');

        session.admitted = true;
        const joinedCall = store.joinCall(call.id, user.id, deviceId, now);
        // What this device should use to reach the others, decided per device rather
        // than once for the deployment: relay credentials expire, and they carry the
        // name of whoever they were issued to.
        session.ice = iceConfigFor({ config, now, name: deviceId || user.id }).iceServers;
        addPeer(session);

        emit(session, 'serverInfo', {
            peers_count: room.size,
            is_presenter: false,
            join_locked: false,
            maxRoomParticipants: config.maxParticipants,
        });
        fanOutJoin(session);

        log.info('signal_admitted', {
            peerId: session.id,
            callId: call.id,
            userId: user.id,
            deviceId: deviceId || null,
            peers: room.size,
        });
        if (onAdmitted) onAdmitted(session, joinedCall.ok ? joinedCall.call : call);
    }

    function handleRelay(session, payload, kind) {
        if (!session.admitted) return refuse(session, 'not_admitted');
        if (!take(session, 'relay', config.relayPerSecond)) return;

        let relay;
        try {
            relay = kind === 'sdp'
                ? validate.validateRelaySdp(payload, { maxSdpBytes: config.sdpBytes })
                : validate.validateRelayIce(payload, { maxIceBytes: config.iceBytes });
        } catch (error) {
            return malformed(session, error.reason || 'invalid_relay');
        }

        const room = rooms.get(session.room);
        // The end of a peer's candidates has nothing to forward and no target.
        if (relay.endOfCandidates) return;
        const target = room?.get(relay.peerId);
        // Scoped to the sender's own call: an id from anywhere else is refused and
        // the sender is told nothing, so probing learns nothing.
        if (!target) {
            log.warn('relay_denied', {
                reason: 'target_not_in_call',
                from: session.id,
                callId: session.callId,
                kind,
            });
            return;
        }

        if (kind === 'sdp') {
            emit(target, 'sessionDescription', {
                peer_id: session.id,
                session_description: relay.description,
            });
        } else {
            emit(target, 'iceCandidate', {
                peer_id: session.id,
                ice_candidate: relay.candidate,
            });
        }
    }

    function handlePeerStatus(session, payload) {
        if (!session.admitted) return refuse(session, 'not_admitted');
        if (!take(session, 'status', config.statusPerSecond)) return;

        let status;
        try {
            status = validate.validatePeerStatus(payload);
        } catch (error) {
            return malformed(session, error.reason || 'invalid_peer_status');
        }

        // The identity fields are the server's, not the sender's: a peer may
        // describe its own media and nobody else's.
        if (status.roomId !== session.room || status.peerId !== session.id
            || status.peerName !== session.peerName) {
            log.warn('relay_denied', {
                reason: 'peer_status_identity_mismatch',
                from: session.id,
                callId: session.callId,
            });
            return;
        }

        const room = rooms.get(session.room);
        if (!room) return;
        const broadcast = {
            peer_id: session.id,
            peer_name: session.peerName,
            element: status.element,
            status: status.status,
            extras: status.extras,
        };
        for (const peer of room.values()) {
            if (peer === session) continue;
            emit(peer, 'peerStatus', broadcast);
        }
    }

    // ── Connection lifecycle ────────────────────────────────────────────────────

    function handleFrame(session, text) {
        if (!text.length) return malformed(session, 'empty_frame');
        const type = text[0];
        const body = text.slice(1);

        switch (type) {
            case ENGINE_OPEN:
                return malformed(session, 'client_sent_open');
            case ENGINE_PING:
                return raw(session, ENGINE_PONG);
            case ENGINE_PONG:
                session.lastSeen = Date.now();
                return;
            case ENGINE_MESSAGE:
                break;
            default:
                return malformed(session, `unknown_engine_packet_${type}`);
        }

        const socketType = body[0];
        const rest = body.slice(1);
        switch (socketType) {
            case '0': {
                if (session.namespaceConnected) return malformed(session, 'duplicate_namespace_connect');
                session.namespaceConnected = true;
                return raw(session, `40${JSON.stringify({ sid: session.id })}`);
            }
            case '1':
                return session.ws.close(1000, 'client disconnect');
            case '2': {
                let parsed;
                try {
                    parsed = JSON.parse(rest);
                } catch {
                    return malformed(session, 'event_not_json');
                }
                if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') {
                    return malformed(session, 'event_not_an_array');
                }
                const [name, payload] = parsed;
                session.lastSeen = Date.now();
                switch (name) {
                    case 'join': return handleJoin(session, payload);
                    case 'relaySDP': return handleRelay(session, payload, 'sdp');
                    case 'relayICE': return handleRelay(session, payload, 'ice');
                    case 'peerStatus': return handlePeerStatus(session, payload);
                    default:
                        log.debug('signal_unknown_event', { peerId: session.id, name: name.slice(0, 40) });
                        return;
                }
            }
            default:
                return malformed(session, `unknown_socket_packet_${socketType}`);
        }
    }

    function connection(ws, req, admission) {
        const url = new URL(req.url, 'http://localhost');
        // A device that authenticated with its own key is named by that session; the
        // query parameter is the older path, for clients that have no key yet.
        const deviceId = admission.device?.id || validDeviceId(url.searchParams.get('device'));
        const session = {
            id: crypto.randomBytes(15).toString('base64url').slice(0, 20),
            ws,
            identity: admission.identity,
            deviceId,
            // Filled in at admission, once the person behind the socket is known.
            ice: null,
            admitted: false,
            departed: false,
            namespaceConnected: false,
            callId: null,
            room: null,
            userId: null,
            peerName: null,
            peerUuid: null,
            peerAvatar: '',
            media: null,
            lastSeen: Date.now(),
            malformedCount: 0,
            buckets: { relay: [], status: [] },
        };

        raw(session, `${ENGINE_OPEN}${JSON.stringify({
            sid: session.id,
            upgrades: [],
            pingInterval: config.pingIntervalMs,
            pingTimeout: config.pingTimeoutMs,
            maxPayload: config.messageBytes,
        })}`);
        connections.add(session);

        ws.on('message', (data, isBinary) => {
            session.lastSeen = Date.now();
            if (isBinary) return malformed(session, 'binary_frame');
            let text;
            try {
                text = data.toString('utf8');
            } catch {
                return malformed(session, 'undecodable_frame');
            }
            try {
                handleFrame(session, text);
            } catch (error) {
                // A handler must never be able to end the process, whatever it is
                // handed. The previous server could be crashed into a restart loop
                // by one message whose `peer_id` was a prototype key.
                log.error('signal_handler_error', {
                    peerId: session.id,
                    message: String(error && error.message).slice(0, 200),
                });
                malformed(session, 'handler_error');
            }
        });

        ws.on('close', () => {
            connections.delete(session);
            // During shutdown the call bookkeeping has already been done and the
            // database is about to close; running it again here would race that.
            if (closed) return;
            // A session that was already evicted has had its departure announced and
            // its call membership closed out; doing it again would double-count the
            // leave and emit a second call-status for it.
            if (!session.admitted || session.departed) return;
            removePeer(session);
            announceDeparture(session);
            log.info('peer_left', {
                peerId: session.id,
                callId: session.callId,
                userId: session.userId,
                deviceId: session.deviceId || null,
            });
            if (onClosed) onClosed(session, 'closed');
        });

        ws.on('error', (error) => {
            log.warn('signal_socket_error', {
                peerId: session.id,
                message: String(error && error.message).slice(0, 200),
            });
        });
    }

    function validDeviceId(value) {
        return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
    }

    /**
     * The person a socket proved itself to be.
     *
     * A device session names the person by id, because that is what the key was
     * enrolled to; a transport identity names them by login, which is how a private
     * deployment has always worked and must keep working.
     */
    function userForIdentity(identity) {
        if (!identity) return null;
        return identity.userId ? store.userById(identity.userId) : store.userByLogin(identity.login);
    }

    function handleUpgrade(req, socket, head) {
        let url;
        try {
            url = new URL(req.url, 'http://localhost');
        } catch {
            return socket.destroy();
        }
        if (url.pathname !== config.signalPath) return socket.destroy();
        if (url.searchParams.get('EIO') !== '4' || url.searchParams.get('transport') !== 'websocket') {
            socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            return socket.destroy();
        }

        // A browser sends an Origin on a WebSocket handshake and one that is not this
        // deployment's is refused. A native client sends none at all, and an absent
        // header is not a claim — it is the absence of one, which is why it is allowed.
        const origin = req.headers.origin;
        if (origin && origin !== config.publicOrigin) {
            log.warn('signal_origin_refused', { origin: String(origin).slice(0, 120) });
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return socket.destroy();
        }

        const now = new Date().toISOString();
        const transport = resolveIdentity(req, config);
        const deviceSession = auth.sessionFromRequest(req, { store, config, now });

        // The socket is where calls actually happen, so it cannot be the way around the
        // rule the API enforces.
        if (config.requireDeviceAuth && !deviceSession) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            return socket.destroy();
        }

        // What the transport says about a device that has a key of its own is recorded
        // as additional evidence, never as the identity: the key is what decides.
        if (deviceSession && transport?.login) {
            store.rememberAuthenticator({
                id: `auth_${auth.randomId(12)}`,
                deviceId: deviceSession.device.id,
                type: 'tailscale',
                externalSubject: transport.login,
                metadata: { name: transport.name || '', at: 'socket' },
                now,
            });
        }

        const admission = deviceSession
            ? {
                identity: {
                    source: 'device',
                    name: deviceSession.user.displayName,
                    userId: deviceSession.user.id,
                    deviceId: deviceSession.device.id,
                },
                device: deviceSession.device,
            }
            : { identity: transport, device: null };

        wss.handleUpgrade(req, socket, head, (ws) => connection(ws, req, admission));
    }

    function start() {
        heartbeat = setInterval(() => {
            const now = Date.now();
            const deadline = config.pingIntervalMs + config.pingTimeoutMs;
            // Every connection, not only the admitted ones: a socket that never joins
            // still occupies the server, and an idle one has to be reaped.
            for (const session of connections) {
                if (now - session.lastSeen > deadline) {
                    log.info('signal_ping_timeout', { peerId: session.id, callId: session.callId });
                    session.ws.terminate();
                    continue;
                }
                raw(session, ENGINE_PING);
            }
        }, config.pingIntervalMs);
        heartbeat.unref?.();
    }

    function attach(httpServer) {
        httpServer.on('upgrade', handleUpgrade);
        start();
    }

    function close() {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        // Terminated rather than closed politely: a shutdown must not wait on a peer
        // that may never answer, and every client reconnects on its own.
        for (const session of sessions.values()) {
            try {
                session.ws.terminate();
            } catch {
                /* already gone */
            }
        }
        sessions.clear();
        rooms.clear();
        connections.clear();
        wss.close();
    }

    /** Test/observability view of the room table. */
    function snapshot() {
        return [...rooms.entries()].map(([room, peers]) => ({
            room,
            peers: [...peers.values()].map((peer) => ({
                id: peer.id,
                userId: peer.userId,
                deviceId: peer.deviceId,
                callId: peer.callId,
            })),
        }));
    }

    return { attach, close, snapshot, wss, sessions, rooms, _maxParticipants: () => config.maxParticipants };
}

module.exports = { createSignalServer };
