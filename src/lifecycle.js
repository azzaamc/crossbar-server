'use strict';

// The call lifecycle, in one place.
//
// HTTP routes and the signalling socket are both thin adapters over these
// functions, so a rule about who may ring whom, or what ends a call, is written
// once. The two adapters differ only in how they learn who is asking.

const crypto = require('node:crypto');
const machine = require('./calls');

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * How many times one ring is attempted when the relay never answers at all.
 *
 * One repeat is all it takes, and is worth it: the relay records what became of a request
 * and answers a repeat carrying the same `request_id` from that record (`pushrelay.js`,
 * `requestIdFor`), so a single repeat decides whether the first attempt was accepted,
 * refused, or marked a dead token whose answer was lost on the way back. A relay that fails
 * twice inside one ring's seconds is not going to answer inside them either. Only a request
 * that never got an answer is repeated — see `ringPhones`.
 */
const RING_ATTEMPTS = 2;

/** The wait before that one repeat. Short: this is a phone ringing now. */
const RING_RETRY_MS = 250;

/** How many owed relay deletions one sweep attempts. */
const RELAY_DELETION_BATCH = 20;

/**
 * The schedule for a relay deletion the relay would not confirm.
 *
 * Doubling from thirty seconds to a fifteen-minute cap. A relay that is deploying, or down
 * for an hour, is asked again often enough to finish within a minute of coming back; a
 * deployment whose relay will never answer costs one request per owed device per fifteen
 * minutes rather than a burst that hides the problem. The delay never becomes a limit: the
 * only thing that clears a row is the relay's own `2xx` or `404`, or a later request for
 * the same device resetting it.
 */
const RELAY_DELETION_RETRY_MS = 30000;
const RELAY_DELETION_RETRY_MAX_MS = 15 * 60 * 1000;

/** A wait, as a promise. Used only for the one ring repeat. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a repeat of a ring can still learn something the first attempt did not.
 *
 * Only a request that got no answer at all: the relay records what became of every request it
 * received and answers a repeat carrying the same `request_id` from that record, so the
 * repeat is how a lost answer is found again. A refusal this process made before sending
 * anything — no relay configured, an id the relay would reject — left no record behind and
 * has nothing to replay, and status 0 is what both of those look like.
 */
function worthRepeating(outcome) {
    return outcome.status === 0 && outcome.error === 'unreachable';
}

/** Sliding-window limiter, per process. Adequate for a directory, and honest about it. */
function createLimiter() {
    const buckets = new Map();
    return {
        take(key, limit, windowMs) {
            const now = Date.now();
            const earliest = now - windowMs;
            const recent = (buckets.get(key) || []).filter((value) => value > earliest);
            if (recent.length >= limit) {
                buckets.set(key, recent);
                return false;
            }
            recent.push(now);
            buckets.set(key, recent);
            if (buckets.size > 1000) {
                for (const [bucketKey, values] of buckets) {
                    const kept = values.filter((value) => value > earliest);
                    if (kept.length) buckets.set(bucketKey, kept);
                    else buckets.delete(bucketKey);
                }
            }
            return true;
        },
    };
}

/**
 * The relay removals this server owes, and the sweep that pays them.
 *
 * A device leaves the relay by `DELETE /v1/devices/{id}`, and that request is the one part
 * of removing a device this machine cannot decide: if it times out, the relay still holds the
 * row — and the phone's PushKit token with it, so no other server can register the phone
 * (`409 token_conflict`) and it cannot be rung by anybody. So the intent is durable
 * (`pending_relay_deletions`, written by `store.revokeDevice` and by `forgetDeviceAtRelay`)
 * and the sweep retries it until the relay itself says it is done: any `2xx`, or a `404`
 * meaning the relay has no such registration — never had one, already removed it, or removed
 * it in answer to an attempt whose reply was lost.
 *
 * It is its own factory rather than a closure inside `createLifecycle` because the
 * operations CLI needs exactly this and nothing else from the lifecycle: a store, a relay
 * client and a logger, with no event bus, no APNs session and no Web Push module to build
 * first.
 */
function createRelayDeletions({ store, relay, log }) {
    const now = () => new Date().toISOString();

    /** When the attempt after this one is due, given how many have already failed. */
    function dueAfter(attempts, at) {
        const backoff = Math.min(RELAY_DELETION_RETRY_MS * 2 ** attempts, RELAY_DELETION_RETRY_MAX_MS);
        return new Date(Date.parse(at) + backoff).toISOString();
    }

    /**
     * The removal each device presently has in flight, so two callers cannot both ask.
     *
     * Two things ask the relay to remove a device: `forgetDeviceAtRelay`, because a caller
     * wants it gone now, and the sweep, because the row is due. Both meter against the same
     * installation's device-write allowance at the relay, and a row written due immediately is
     * visible to a sweep tick in the same second — so without this, one device's removal is
     * issued and paid for twice, and a household's allowance is what pays. The relay's DELETE
     * is idempotent in effect, so the duplicate has no upside: the second caller joins the
     * attempt already running and is given its answer instead of sending its own.
     *
     * This closes the window because both callers read the row and start the attempt in one
     * synchronous step — the sweep selects its batch and calls `attempt` for every row before
     * it yields — so neither can observe the other's request mid-flight. It is deliberately
     * not durable: the queue is owned by one process, as the relay client and the limiter are.
     * A completed removal leaves nothing for a later selection to find, so it is never
     * attempted a second time.
     */
    const inFlight = new Map();

    /**
     * One attempt at one owed deletion, joined to any attempt already running for the device.
     *
     * `performRemoval` does the work; this decides whether there is work to do.
     */
    function attempt(row, at) {
        const running = inFlight.get(row.deviceId);
        if (running) return running;
        // Held until the request is answered, so a caller arriving while it is unanswered
        // joins it rather than asking a second time. The row for a settled attempt is cleared
        // or deferred by then, which is what leaves the map safe to empty.
        const tracked = performRemoval(row, at).finally(() => inFlight.delete(row.deviceId));
        inFlight.set(row.deviceId, tracked);
        return tracked;
    }

    /**
     * One attempt at one owed deletion, and what it leaves behind.
     *
     * `2xx` is the relay having removed the device; `404` is the relay having nothing to
     * remove. Both are the deletion being *done*, and both clear the row. Everything else —
     * a request that never got an answer, a `429`, a `5xx`, a `403` from a suspended
     * installation — leaves the row in place with the next attempt scheduled, because a row
     * cleared while the relay still holds the token is the orphan this queue exists to
     * prevent, and a refusal is not a removal no matter how permanent it looks.
     */
    async function performRemoval(row, at) {
        const outcome = await relay.removeDevice({ deviceId: row.deviceId });
        if (outcome.ok || outcome.status === 404) {
            store.clearPendingRelayDeletion(row.deviceId);
            return { deviceId: row.deviceId, done: true, outcome };
        }
        const nextAttemptAt = dueAfter(row.attempts, at);
        store.deferPendingRelayDeletion({
            deviceId: row.deviceId,
            now: at,
            nextAttemptAt,
            error: outcome.error || 'unreachable',
        });
        log.warn('push_relay_deletion_pending', {
            deviceId: row.deviceId,
            status: outcome.status,
            error: outcome.error || 'unreachable',
            attempts: row.attempts + 1,
            retryInSeconds: Math.round((Date.parse(nextAttemptAt) - Date.parse(at)) / 1000),
        });
        return { deviceId: row.deviceId, done: false, nextAttemptAt, outcome };
    }

    /**
     * Tell the relay a device is gone, now, and go on owing it until the relay says so.
     *
     * The durable record is written first, so this call is not what stands between a
     * deletion and its retry: `store.revokeDevice` already wrote one for every local path
     * that revokes a device, and a caller reaching here directly gets one too. Asking again
     * for a device that is already owed resets that row's schedule rather than adding a
     * second one.
     *
     * A relay that refuses or cannot be reached is reported, never raised: the caller is
     * answering somebody who asked for a removal, and "this server's half is done, the
     * relay's half is queued" is the truth rather than an error. A sweep already asking about
     * this device is joined rather than raced, so the answer here is that attempt's.
     */
    async function forgetDeviceAtRelay(deviceId, { at = now() } = {}) {
        if (!relay.enabled) return { configured: false, queued: false, outcome: null };
        store.addPendingRelayDeletion(deviceId, at);
        const { done, outcome } = await attempt({ deviceId, attempts: 0 }, at);
        return { configured: true, queued: !done, outcome };
    }

    /**
     * Every owed deletion that is due, each attempted once.
     *
     * In parallel, because the requests are independent and a relay that is down should cost
     * one deadline rather than a batch of them. `at` is the moment the sweep is running, and
     * it is the caller's — the same way `store.expireCalls` is given its cutoff — so a test
     * can say when "now" is rather than waiting for a schedule to come round.
     *
     * A due row another caller is already working on is not asked about a second time: the
     * attempt in flight is awaited and its answer is what this sweep reports, so a device
     * revoked a moment before the tick is not paid for twice from the installation's
     * device-write allowance.
     */
    async function retryPendingRelayDeletions({ at = now() } = {}) {
        if (!relay.enabled) return { configured: false, attempted: 0, settled: [], pending: [] };
        const due = store.pendingRelayDeletions(at, RELAY_DELETION_BATCH);
        const results = await Promise.all(due.map((row) => attempt(row, at)));
        return {
            configured: true,
            attempted: due.length,
            settled: results.filter((result) => result.done).map((result) => result.deviceId),
            pending: results.filter((result) => !result.done).map((result) => result.deviceId),
        };
    }

    return { forgetDeviceAtRelay, retryPendingRelayDeletions };
}

function createLifecycle({ config, store, bus, push, apns, relay, log }) {
    const limiter = createLimiter();
    const relayDeletions = createRelayDeletions({ store, relay, log });
    const now = () => new Date().toISOString();

    function publicCall(call) {
        return store.callPublic(call);
    }

    /**
     * Where a client joins the media for this call.
     *
     * It is a page URL because both clients already know how to read it: the native
     * client takes the `room` query item and the origin from it, and the PWA loads it
     * in its call frame. The room is carried as a query item, not a credential —
     * admission is decided from identity and call membership, never from knowing it.
     */
    function joinUrl(call) {
        return `${config.publicOrigin}/call?call=${encodeURIComponent(call.id)}&room=${encodeURIComponent(call.roomId)}`;
    }

    function signallingFor(call) {
        const url = new URL(config.publicOrigin);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.pathname = config.signalPath;
        url.search = '?EIO=4&transport=websocket';
        return { url: url.toString(), room: call.roomId, eio: 4, transport: 'websocket' };
    }

    function envelope(call) {
        return { call: publicCall(call), joinUrl: joinUrl(call), signalling: signallingFor(call) };
    }

    function emitToParticipants(call) {
        for (const participant of call.participants) {
            bus.emit(participant.userId, 'call-status', publicCall(call));
        }
    }

    function announceOngoing(call) {
        if (call.status === 'active') bus.broadcast('ongoing-call', publicCall(call));
    }

    function validIds(value) {
        if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null;
        const unique = [...new Set(value.map(String))];
        return unique.every((id) => ID_PATTERN.test(id)) ? unique : null;
    }

    /**
     * Rings everybody who is not already holding a connection.
     *
     * Two transports, because a browser and a phone are woken by different things: Web Push
     * reaches a page, and nothing but a VoIP push reaches a suspended app. The wake goes
     * through the relay, which is the party holding the Apple key for the shared app
     * identity; this deployment registers each phone's VoIP token there when the app
     * presents it. Each transport reports the addresses it could not reach, and each of
     * those is cleared where its own rows live — a refusal from the transport is the only
     * evidence that a token has died.
     */
    async function pushIncoming(call, inviteeIds) {
        const caller = store.userById(call.callerId);
        // The name is drawn on a lock screen before that phone has spoken to this server at
        // all, so it has to travel in the push. "Someone" is what is left when the caller
        // has no name — deliberately not a relationship, which the server is in no position
        // to assert about two people.
        const callerName = caller?.displayName || 'Someone';

        const subscriptions = store.pushSubscriptionsFor(inviteeIds);
        const staleEndpoints = await push.incoming(subscriptions, call, callerName);
        for (const endpoint of staleEndpoints) store.deletePushEndpoint(endpoint);

        const devices = store.voipTokensFor(inviteeIds);
        // Said out loud rather than passed over: without a relay there is no VoIP transport
        // at all, and "the phone did not ring" is otherwise indistinguishable from "the push
        // was refused" without reading the relay's log too.
        if (devices.length && !relay.enabled) {
            log.warn('push_relay_not_configured', { callId: call.id, phones: devices.length });
        }
        const deadTokens = await ringPhones(devices, call, callerName);
        for (const device of deadTokens) store.clearVoipToken(device.deviceId);

        if (subscriptions.length || devices.length) {
            log.info('push_dispatched', {
                callId: call.id,
                subscriptions: subscriptions.length,
                phones: devices.length,
                dropped: staleEndpoints.length + deadTokens.length,
            });
        }
    }

    /**
     * One relay push per phone, and the phones whose VoIP token the relay says is gone.
     *
     * `request_id` is per device as well as per call, because the relay keys duplicate
     * suppression on `(installation_id, request_id)` — one id for a fan-out is refused with
     * a `409` for the second phone. It is derived from the call and the device rather than
     * stored, so an attempt repeated after a timeout carries the same id with nothing to
     * keep in step (`pushrelay.js`, `requestIdFor`), and only a new call or a new device
     * gets a new one.
     *
     * A ring the relay *answered* is never sent again: accepted, refused and unknown-device
     * are all answers, and a second push would be a second ring (`RING_ATTEMPTS`). An attempt
     * that never got an answer is the exception, and it is repeated with the same
     * `request_id` — because the relay recorded what became of the first one and answers a
     * repeat from its record ("The idempotency contract", relay `docs/API.md`). That is what
     * recovers the ring the relay marked a dead token and whose `410` was lost on the way
     * back: without the repeat the backend keeps a token the relay will never ring again,
     * and without the same `request_id` the repeat would ring a phone the relay has already
     * given up on twice.
     *
     * A push the relay answered is not retried here and never changes call state: the ring
     * has the seconds it has, and a call that rings late is worse than one that does not ring.
     */
    async function ringPhones(devices, call, callerName) {
        if (!devices.length) return [];
        const outcomes = await Promise.all(devices.map(async (device) => {
            const requestId = relay.requestIdFor(call.id, device.deviceId);
            let outcome;
            for (let attempt = 0; attempt < RING_ATTEMPTS; attempt += 1) {
                if (attempt) await delay(RING_RETRY_MS);
                outcome = await relay.sendIncomingCall({
                    deviceId: device.deviceId,
                    requestId,
                    callId: call.id,
                    callerId: call.callerId,
                    callerName,
                    hasVideo: call.kind !== 'audio',
                });
                // Only an attempt the relay never answered is worth repeating; see
                // `worthRepeating`.
                if (!worthRepeating(outcome)) break;
            }
            return outcome;
        }));
        return devices.filter((_, index) => outcomes[index].deviceGone);
    }

    /**
     * The people a call was placed to who never answered it.
     *
     * `invited` is somebody still being rung and `missed` is somebody it has already rung
     * out for — the sweep marks them before anybody gets to look — and both are the same
     * thing: rung, and never spoken to. Nobody else is.
     */
    function unanswered(call) {
        return (call?.participants || [])
            .filter((participant) => participant.status === 'invited' || participant.status === 'missed')
            .map((participant) => participant.userId);
    }

    /**
     * Tells the people who were rung and did not answer.
     *
     * A ring is a VoIP push because nothing else reaches a suspended app. A missed call is
     * the other way round: nobody is waiting for it, the app may never be opened, and what
     * is wanted is a line on a lock screen — so it goes through the notification system,
     * which is a different token and a different topic.
     *
     * Only to somebody who was not holding a connection while it rang. A person whose app
     * was open was told by the call itself, and telling them again in writing is how an app
     * teaches somebody to turn its notifications off.
     */
    async function pushMissed(call, inviteeIds) {
        const absent = inviteeIds.filter((id) => !bus.isOnline(id));
        if (!absent.length) return;

        const caller = store.userById(call.callerId);
        const devices = store.alertTokensFor(absent);
        const dead = await apns.alert(devices, {
            callId: call.id,
            title: `Missed call from ${caller?.displayName || 'Someone'}`,
            body: call.kind === 'audio' ? 'Audio call' : 'Video call',
        });
        for (const device of dead) store.clearAlertToken(device.deviceId);

        if (devices.length) {
            log.info('push_missed', { callId: call.id, phones: devices.length, dropped: dead.length });
        }
    }

    function createCall({ user, inviteeIds, deviceId, kind = 'video' }) {
        if (!limiter.take(`${user.id}:create`, 6, 60000)) return { ok: false, reason: 'RATE_LIMITED' };
        const ids = validIds(inviteeIds);
        if (!ids) return { ok: false, reason: 'INVALID_INVITEES' };

        // Including yourself is how a person rings their own other devices — the
        // phone ringing the laptop. It is off unless the operator turns it on,
        // because a call nobody else can answer is not a call.
        const others = ids.filter((id) => id !== user.id);
        if (others.length !== ids.length && !config.allowSelfCalls) {
            return { ok: false, reason: 'INVALID_INVITEES' };
        }

        if (!others.length) {
            const callId = crypto.randomUUID();
            const call = store.createCall({
                id: callId,
                roomId: crypto.randomUUID(),
                callerId: user.id,
                deviceId,
                inviteeIds: [],
                kind,
                // Nobody to ring, so there is nothing to wait for: the call is up
                // and the person's other devices can join it.
                status: 'active',
                now: now(),
            });
            announceOngoing(call);
            log.info('call_created', { callId, callerId: user.id, inviteeIds: [], deviceId: deviceId || null, self: true });
            return { ok: true, call, allowed: [] };
        }

        const allowed = store.allowedContacts(user.id, others);
        if (allowed.length !== others.length) return { ok: false, reason: 'CONTACT_NOT_ALLOWED' };

        const callId = crypto.randomUUID();
        const roomId = crypto.randomUUID();
        const call = store.createCall({
            id: callId,
            roomId,
            callerId: user.id,
            deviceId,
            inviteeIds: others,
            kind,
            now: now(),
        });

        for (const invitee of allowed) bus.emit(invitee.id, 'incoming-call', publicCall(call));
        void pushIncoming(call, others).catch((error) => log.warn('push_failed', { message: String(error.message).slice(0, 120) }));
        log.info('call_created', { callId, callerId: user.id, inviteeIds: others, deviceId: deviceId || null });
        return { ok: true, call, allowed };
    }

    function respond({ user, callId, response, deviceId }) {
        if (!limiter.take(`${user.id}:respond`, 20, 60000)) return { ok: false, reason: 'RATE_LIMITED' };
        if (response !== 'accepted' && response !== 'declined') return { ok: false, reason: 'INVALID_RESPONSE' };

        const call = store.callById(callId);
        if (!call || !store.participant(callId, user.id)) return { ok: false, reason: 'CALL_NOT_FOUND' };
        if (!machine.isLive(call.status)) return { ok: false, reason: 'CALL_EXPIRED' };

        const result = store.respond(callId, user.id, response, now());
        if (!result.ok) return result;

        emitToParticipants(result.call);
        announceOngoing(result.call);
        log.info(`call_${response}`, { callId, userId: user.id, deviceId: deviceId || null });
        return { ok: true, call: result.call, declined: response === 'declined' };
    }

    function join({ user, callId, deviceId }) {
        const call = store.callById(callId);
        if (!call) return { ok: false, reason: 'CALL_NOT_FOUND' };
        const participant = store.participant(callId, user.id);
        const refusal = machine.joinRefusal(call, participant);
        if (refusal) return { ok: false, reason: refusal };

        const result = store.joinCall(callId, user.id, deviceId, now());
        if (!result.ok) return result;

        announceOngoing(result.call);
        log.info('call_joined', { callId, userId: user.id, deviceId: deviceId || null });
        return { ok: true, call: result.call };
    }

    function invite({ user, callId, inviteeIds, deviceId }) {
        if (!limiter.take(`${user.id}:invite`, 12, 60000)) return { ok: false, reason: 'RATE_LIMITED' };
        const ids = validIds(inviteeIds);
        if (!ids || ids.includes(user.id)) return { ok: false, reason: 'INVALID_INVITEES' };
        const allowed = store.allowedContacts(user.id, ids);
        if (allowed.length !== ids.length) return { ok: false, reason: 'CONTACT_NOT_ALLOWED' };

        const result = store.addInvitees(callId, user.id, ids, now());
        if (!result.ok) return result;

        for (const id of result.added) bus.emit(id, 'incoming-call', publicCall(result.call));
        if (result.added.length) {
            void pushIncoming(result.call, result.added)
                .catch((error) => log.warn('push_failed', { message: String(error.message).slice(0, 120) }));
        }
        emitToParticipants(result.call);
        announceOngoing(result.call);
        log.info('call_invited', { callId, inviterId: user.id, inviteeIds: result.added, deviceId: deviceId || null });
        return { ok: true, call: result.call, added: result.added };
    }

    /**
     * One device leaves. The person leaves only when none of their devices is still
     * in the call, and the call ends only when nobody is left in it — which is the
     * difference between a four-person call losing one person and losing the call.
     */
    function leave({ user, callId, deviceId, reason = 'left' }) {
        const result = store.leaveCall(callId, user.id, deviceId, now());
        if (!result.ok) return result;

        emitToParticipants(result.call);
        if (result.ended) bus.broadcast('ongoing-call', publicCall(result.call));
        log.info('call_left', {
            callId,
            userId: user.id,
            deviceId: deviceId || null,
            reason,
            ended: Boolean(result.ended),
        });
        return { ok: true, call: result.call, ended: Boolean(result.ended) };
    }

    function end({ user, callId }) {
        // Read before it ends: whether anybody ever picked up is the difference between a
        // call that finished and one that was never answered, and afterwards there is
        // nothing left to ask.
        const before = store.callById(callId);
        const result = store.endCall(callId, user.id, now());
        if (!result.ok) return result;
        emitToParticipants(result.call);
        bus.broadcast('ongoing-call', publicCall(result.call));

        // Hung up while it was still ringing: these people were rung and never got to speak,
        // which is the whole of what a missed call is.
        if (before?.status === 'ringing') {
            void pushMissed(before, unanswered(before))
                .catch((error) => log.warn('push_failed', { message: String(error.message).slice(0, 120) }));
        }
        log.info('call_ended', { callId, userId: user.id, status: result.call.status });
        return result;
    }

    /** A signalling socket closed without a `leave` — the ordinary way a call ends. */
    function deviceLeftBySocket({ callId, userId, deviceId, peerId }) {
        if (!callId || !userId) return;
        const result = store.leaveCall(callId, userId, deviceId, now());
        if (!result.ok) return;
        emitToParticipants(result.call);
        if (result.ended) bus.broadcast('ongoing-call', publicCall(result.call));
        log.info('call_left', {
            callId,
            userId,
            deviceId: deviceId || null,
            peerId,
            reason: 'socket_closed',
            ended: Boolean(result.ended),
        });
    }

    function expire() {
        const cutoff = new Date(Date.now() - config.callRingSeconds * 1000).toISOString();
        const expired = store.expireCalls(cutoff, now());
        for (const callId of expired) {
            const call = store.callById(callId);
            if (call) {
                emitToParticipants(call);
                // Read after the sweep, which has just marked the unanswered as missed.
                void pushMissed(call, unanswered(call))
                    .catch((error) => log.warn('push_failed', { message: String(error.message).slice(0, 120) }));
            }
            log.info('call_missed', { callId });
        }
        return expired;
    }

    return {
        limiter,
        publicCall,
        joinUrl,
        signallingFor,
        envelope,
        createCall,
        respond,
        join,
        invite,
        leave,
        end,
        deviceLeftBySocket,
        expire,
        pushIncoming,
        emitToParticipants,
        announceOngoing,
        // The relay half of removing a device, so the console, the CLI and the app's own
        // unpair all go through one queue (see `createRelayDeletions`).
        forgetDeviceAtRelay: relayDeletions.forgetDeviceAtRelay,
        retryPendingRelayDeletions: relayDeletions.retryPendingRelayDeletions,
    };
}

module.exports = { createLifecycle, createRelayDeletions };
