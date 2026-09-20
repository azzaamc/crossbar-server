'use strict';

// The browser half of a Crossbar call.
//
// It speaks the same signalling vocabulary as the native client — Engine.IO v4 over
// a WebSocket, `join`, `addPeer`, `relaySDP`, `relayICE`, `peerStatus`, `removePeer`
// — so the two interoperate, and media is peer-to-peer exactly as it is natively.
//
// The page is loaded two ways and has to behave in both: opened directly, which is
// how a call is tested without a second phone, and inside the household PWA's call
// frame, where navigating to /newcall is the signal that the call is over.

const params = new URLSearchParams(location.search);
const callId = params.get('call') || '';
const roomFromUrl = params.get('room') || '';
const audioProcessingEnabled = params.get('audioProcessing') !== '0';

const tilesEl = document.getElementById('tiles');
const statusEl = document.getElementById('status');
const headlineEl = document.getElementById('status-headline');
const detailEl = document.getElementById('status-detail');
const muteButton = document.getElementById('toggle-mute');
const cameraButton = document.getElementById('toggle-camera');
const endButton = document.getElementById('end');

const state = {
    socket: null,
    admitted: false,
    myPeerId: '',
    myName: '',
    peers: new Map(), // peerId -> { pc, name, videoEl, videoOff }
    pendingIce: new Map(), // peerId -> RTCIceCandidateInit[]
    localStream: null,
    muted: false,
    cameraOn: true,
    leaving: false,
    lines: [],
};

// ── Small helpers ───────────────────────────────────────────────────────────────

function deviceId() {
    const key = 'crossbar.device';
    let value = localStorage.getItem(key);
    if (!value || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
        value = `web-${crypto.randomUUID()}`;
        localStorage.setItem(key, value);
    }
    return value;
}

function peerUuid() {
    const key = 'crossbar.peerUuid';
    let value = localStorage.getItem(key);
    if (!value) {
        value = crypto.randomUUID();
        localStorage.setItem(key, value);
    }
    return value;
}

function note(line) {
    state.lines.push(`${new Date().toISOString()} ${line}`);
    if (state.lines.length > 200) state.lines.shift();
    detailEl.textContent = state.lines.slice(-3).join('\n');
}

function headline(text) {
    headlineEl.textContent = text;
}

function showStatus(visible) {
    statusEl.hidden = !visible;
}

async function api(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: {
            'content-type': 'application/json',
            'x-crossbar-device': deviceId(),
            ...(options.headers || {}),
        },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error?.message || `Request failed (${response.status})`);
    }
    return data;
}

// ── Tiles ───────────────────────────────────────────────────────────────────────

function addTile(peerId, name, isLocal = false) {
    const tile = document.createElement('div');
    tile.className = isLocal ? 'tile local' : 'tile';
    tile.dataset.peer = peerId;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (isLocal) video.muted = true; // never play your own microphone back
    const offline = document.createElement('div');
    offline.className = 'offline';
    offline.textContent = 'Camera off';
    const caption = document.createElement('div');
    caption.className = 'caption';
    caption.textContent = name;
    tile.append(video, offline, caption);
    tilesEl.append(tile);
    layout();
    return { tile, video };
}

function layout() {
    const count = tilesEl.children.length;
    tilesEl.dataset.count = count >= 4 ? 'many' : String(count);
}

function removeTile(peerId) {
    tilesEl.querySelector(`.tile[data-peer="${CSS.escape(peerId)}"]`)?.remove();
    layout();
}

// ── Signalling ──────────────────────────────────────────────────────────────────

function send(frame) {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) state.socket.send(frame);
}

function emit(name, payload) {
    send(`42${JSON.stringify([name, payload])}`);
}

function connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${location.host}/socket.io/?EIO=4&transport=websocket&device=${encodeURIComponent(deviceId())}`;
    note(`connecting ${url}`);

    const socket = new WebSocket(url);
    state.socket = socket;

    socket.onmessage = (event) => {
        for (const frame of String(event.data).split('\u001e')) handleFrame(frame);
    };
    socket.onclose = () => {
        if (state.leaving) return;
        headline('Disconnected');
        note('signalling socket closed');
        showStatus(true);
    };
    socket.onerror = () => note('signalling socket error');
}

function handleFrame(frame) {
    if (!frame) return;
    const type = frame[0];
    const body = frame.slice(1);
    if (type === '0') {
        send('40');
        return;
    }
    if (type === '2') {
        send('3');
        return;
    }
    if (type !== '4') return;

    const socketType = body[0];
    const rest = body.slice(1);
    if (socketType === '0') {
        try {
            state.myPeerId = JSON.parse(rest).sid || '';
        } catch {
            state.myPeerId = '';
        }
        note(`socket.io connected sid=${state.myPeerId.slice(0, 8)}`);
        sendJoin();
        return;
    }
    if (socketType === '2') {
        let parsed;
        try {
            parsed = JSON.parse(rest);
        } catch {
            return note('unparseable event');
        }
        handleEvent(parsed[0], parsed[1]);
        return;
    }
    if (socketType === '4') note(`connect_error ${rest}`);
}

function sendJoin() {
    emit('join', {
        join_data_time: new Date().toISOString(),
        channel: roomFromUrl,
        channel_password: null,
        peer_info: {
            osName: navigator.platform || 'web',
            osVersion: '',
            browserName: navigator.userAgent.includes('Firefox') ? 'Firefox' : 'Chromium',
            browserVersion: '1',
            extras: {},
        },
        peer_uuid: peerUuid(),
        peer_name: state.myName,
        peer_avatar: '',
        peer_token: null,
        peer_video: true,
        peer_audio: true,
        peer_video_status: state.cameraOn,
        peer_audio_status: !state.muted,
        peer_screen_status: false,
        peer_hand_status: false,
        peer_rec_status: false,
        peer_privacy_status: false,
        userAgent: navigator.userAgent,
    });
    note('join sent');
    headline('Joining…');
}

function handleEvent(name, payload) {
    switch (name) {
        case 'addPeer': return handleAddPeer(payload);
        case 'sessionDescription': return handleSessionDescription(payload);
        case 'iceCandidate': return handleIceCandidate(payload);
        case 'peerStatus': return handlePeerStatus(payload);
        case 'removePeer': return handleRemovePeer(payload);
        case 'serverInfo': return note(`serverInfo peers=${payload?.peers_count ?? '?'}`);
        case 'unauthorized': {
            state.leaving = true;
            headline('Not admitted');
            note(`refused: ${payload?.reason || 'unknown'}`);
            showStatus(true);
            return;
        }
        default: return;
    }
}

// ── Peer connections ────────────────────────────────────────────────────────────

async function handleAddPeer(payload) {
    const peerId = payload?.peer_id;
    if (!peerId || state.peers.has(peerId)) return;

    const { tile, video } = addTile(peerId, payload.peer_name || 'Family', false);
    const pc = new RTCPeerConnection({ iceServers: payload.iceServers || [] });
    const peer = { pc, name: payload.peer_name || 'Family', tile, videoEl: video, videoOff: false };
    state.peers.set(peerId, peer);
    state.pendingIce.set(peerId, []);

    for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);

    pc.onicecandidate = (event) => {
        // `event.candidate` is null for the end of candidates, but WebKit sends an
        // object whose `candidate` string is empty instead — neither is worth a
        // message to the server.
        if (!event.candidate || !event.candidate.candidate) return;
        emit('relayICE', {
            peer_id: peerId,
            ice_candidate: {
                sdpMLineIndex: event.candidate.sdpMLineIndex ?? 0,
                candidate: event.candidate.candidate,
            },
        });
    };

    pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream && video.srcObject !== stream) {
            video.srcObject = stream;
            note(`media from ${peerId.slice(0, 8)}`);
            showStatus(false);
        }
    };

    pc.onconnectionstatechange = () => {
        note(`${peerId.slice(0, 8)} pc ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
            state.admitted = true;
            headline(peerCountLabel());
            showStatus(false);
        }
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            // No ICE restart anywhere in this system yet; say so rather than leaving
            // a frozen picture pretending to be a call.
            peer.videoOff = true;
            peer.tile.dataset.video = 'off';
            headline('Connection failed');
            showStatus(true);
        }
    };

    if (payload.should_create_offer) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        emit('relaySDP', { peer_id: peerId, session_description: { type: 'offer', sdp: offer.sdp } });
        note(`offer -> ${peerId.slice(0, 8)}`);
    }
}

async function handleSessionDescription(payload) {
    const peerId = payload?.peer_id;
    const description = payload?.session_description;
    const peer = state.peers.get(peerId);
    if (!peer || !description) return;

    await peer.pc.setRemoteDescription({ type: description.type, sdp: description.sdp });
    await flushIce(peerId);
    note(`${description.type} <- ${peerId.slice(0, 8)}`);

    if (description.type === 'offer') {
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        emit('relaySDP', { peer_id: peerId, session_description: { type: 'answer', sdp: answer.sdp } });
        note(`answer -> ${peerId.slice(0, 8)}`);
    }
}

function handleIceCandidate(payload) {
    const peerId = payload?.peer_id;
    const candidate = payload?.ice_candidate;
    if (!peerId || !candidate?.candidate) return;
    const peer = state.peers.get(peerId);
    const init = {
        candidate: candidate.candidate,
        sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
        sdpMid: candidate.sdpMid ?? null,
    };
    if (!peer || !peer.pc.remoteDescription) {
        state.pendingIce.get(peerId)?.push(init) ?? state.pendingIce.set(peerId, [init]);
        return;
    }
    peer.pc.addIceCandidate(init).catch((error) => note(`ice add failed: ${error.message}`));
}

async function flushIce(peerId) {
    const peer = state.peers.get(peerId);
    const queued = state.pendingIce.get(peerId) || [];
    if (!peer || !queued.length) return;
    state.pendingIce.set(peerId, []);
    for (const candidate of queued) {
        await peer.pc.addIceCandidate(candidate).catch(() => {});
    }
    note(`flushed ${queued.length} candidates to ${peerId.slice(0, 8)}`);
}

function handlePeerStatus(payload) {
    if (payload?.element !== 'video') return;
    const peer = state.peers.get(payload.peer_id);
    if (!peer) return;
    peer.videoOff = !payload.status;
    peer.tile.dataset.video = payload.status ? 'on' : 'off';
}

function handleRemovePeer(payload) {
    const peerId = payload?.peer_id;
    const peer = state.peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    state.peers.delete(peerId);
    state.pendingIce.delete(peerId);
    removeTile(peerId);
    note(`${peerId.slice(0, 8)} left`);
    headline(peerCountLabel());
}

function peerCountLabel() {
    const count = state.peers.size;
    if (!count) return 'Waiting for someone to join…';
    return count === 1 ? 'Connected' : `Connected · ${count + 1} people`;
}

// ── Media ───────────────────────────────────────────────────────────────────────

async function acquireMedia() {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: audioProcessingEnabled
            ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            : { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    state.localStream = stream;
    const { video } = addTile('local', 'You', true);
    video.srcObject = stream;
    return stream;
}

function setVideoStatus(enabled) {
    if (!state.myPeerId) return;
    emit('peerStatus', {
        room_id: roomFromUrl,
        peer_name: state.myName,
        peer_id: state.myPeerId,
        element: 'video',
        status: enabled,
        extras: {},
    });
}

function applyCameraState() {
    const track = state.localStream?.getVideoTracks()[0];
    if (track) track.enabled = state.cameraOn;
    cameraButton.setAttribute('aria-pressed', String(!state.cameraOn));
    setVideoStatus(state.cameraOn);
}

function applyMuteState() {
    const track = state.localStream?.getAudioTracks()[0];
    if (track) track.enabled = !state.muted;
    muteButton.setAttribute('aria-pressed', String(state.muted));
}

// ── Teardown ────────────────────────────────────────────────────────────────────

async function leave({ tellServer = true } = {}) {
    if (state.leaving) return;
    state.leaving = true;
    headline('Call ended');
    showStatus(true);

    if (tellServer) {
        try {
            await api(`/api/calls/${encodeURIComponent(callId)}/leave`, { method: 'POST' });
        } catch (error) {
            note(`leave: ${error.message}`);
        }
    }

    for (const [, peer] of state.peers) peer.pc.close();
    state.peers.clear();
    state.localStream?.getTracks().forEach((track) => track.stop());
    try {
        state.socket?.close(1000, 'leaving');
    } catch {
        /* already closed */
    }

    // The PWA watches this navigation: a second load of its call frame is how it
    // knows the user hung up.
    location.replace('/newcall');
}

// ── Start ───────────────────────────────────────────────────────────────────────

/**
 * A snapshot of the call, for a console or for an instrument driving this page.
 * Deliberately read-only: it answers "is this call actually carrying media", which
 * is otherwise impossible to tell from the outside of a peer connection.
 */
async function reportStatus() {
    const peers = [];
    for (const [id, peer] of state.peers) {
        let bytesReceived = 0;
        let bytesSent = 0;
        const kinds = {};
        try {
            const stats = await peer.pc.getStats();
            stats.forEach((report) => {
                if (report.type === 'inbound-rtp') {
                    bytesReceived += report.bytesReceived || 0;
                    kinds[report.kind] = { ...(kinds[report.kind] || {}), in: report.bytesReceived || 0 };
                }
                if (report.type === 'outbound-rtp') {
                    bytesSent += report.bytesSent || 0;
                    kinds[report.kind] = { ...(kinds[report.kind] || {}), out: report.bytesSent || 0 };
                }
            });
        } catch {
            /* statistics are unavailable once a connection is closing */
        }
        peers.push({
            id,
            name: peer.name,
            connectionState: peer.pc.connectionState,
            iceConnectionState: peer.pc.iceConnectionState,
            signalingState: peer.pc.signalingState,
            bytesReceived,
            bytesSent,
            kinds,
            videoWidth: peer.videoEl.videoWidth,
            videoHeight: peer.videoEl.videoHeight,
            videoOff: peer.videoOff,
        });
    }
    return {
        peerId: state.myPeerId,
        name: state.myName,
        admitted: state.admitted,
        muted: state.muted,
        cameraOn: state.cameraOn,
        room: roomFromUrl,
        peers,
        lines: state.lines.slice(-12),
    };
}

window.crossbarStatus = reportStatus;

function watchCallStatus() {
    if (!callId) return;
    const source = new EventSource('/api/events');
    source.addEventListener('call-status', (event) => {
        let call;
        try {
            call = JSON.parse(event.data);
        } catch {
            return;
        }
        if (call.id !== callId) return;
        if (['ended', 'cancelled', 'declined', 'missed'].includes(call.status)) {
            source.close();
            void leave({ tellServer: false });
        }
    });
    source.onerror = () => source.close();
}

async function start() {
    muteButton.addEventListener('click', () => {
        state.muted = !state.muted;
        applyMuteState();
    });
    cameraButton.addEventListener('click', () => {
        state.cameraOn = !state.cameraOn;
        applyCameraState();
    });
    endButton.addEventListener('click', () => void leave());

    if (!callId || !roomFromUrl) {
        headline('This link is incomplete');
        note('a call id and room are both required');
        return;
    }

    try {
        showStatus(true);
        headline('Connecting…');
        await acquireMedia();

        const session = await api('/api/session');
        state.myName = session.user?.displayName || session.identity?.name || 'Family';
        note(`who: ${state.myName}`);

        const joined = await api(`/api/calls/${encodeURIComponent(callId)}/join`, { method: 'POST' });
        note(`call ${joined.call?.status || '?'}, room ${roomFromUrl.slice(0, 8)}`);

        connect();
        watchCallStatus();
    } catch (error) {
        headline('Could not join');
        note(error.message);
        showStatus(true);
    }
}

void start();
