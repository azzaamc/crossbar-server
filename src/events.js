'use strict';

// The event stream: one held-open response per signed-in person, and the fan-out
// that keeps them current.
//
// There are no event ids and no replay — that is a deliberate property of the
// contract, not an omission: a client that reconnects re-reads `/api/bootstrap`,
// which is therefore required to be a complete answer to "what is waiting for me".
// The heartbeat keeps an idle connection inside a client's own idle timeout.

const HEARTBEAT_MS = 20000;

function createEventBus({ store, log, heartbeatMs = HEARTBEAT_MS }) {
    const streams = new Map(); // userId -> Map<response, timer>

    function write(response, type, data) {
        try {
            response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch (error) {
            log.warn('sse_write_failed', { message: String(error && error.message).slice(0, 120) });
        }
    }

    function emit(userId, type, data) {
        const set = streams.get(userId);
        if (!set) return;
        for (const response of set.keys()) write(response, type, data);
    }

    function broadcast(type, data) {
        for (const userId of streams.keys()) emit(userId, type, data);
    }

    function isOnline(userId) {
        return (streams.get(userId)?.size || 0) > 0;
    }

    function onlineUserIds() {
        return [...streams.keys()];
    }

    function presence(userId, now) {
        const payload = { userId, online: isOnline(userId), lastSeen: now };
        // Written down, because this is the one fact a client cannot check for itself: a
        // phone told that somebody is offline has no reason to ask again, so a wrong
        // broadcast is invisible from the outside until a person notices the dot. With the
        // stream count, a reproduction says whether they really had none.
        log.info('presence_broadcast', {
            userId,
            online: payload.online,
            streams: streams.get(userId)?.size || 0,
            recipients: streams.size,
        });
        for (const recipientId of streams.keys()) emit(recipientId, 'presence', payload);
    }

    /** Registers a stream and returns the function that removes it again. */
    function add(userId, response) {
        let set = streams.get(userId);
        if (!set) {
            set = new Map();
            streams.set(userId, set);
        }

        const timer = setInterval(() => {
            store.touchPresence(userId, new Date().toISOString());
            try {
                response.write(': heartbeat\n\n');
            } catch {
                /* the close handler tears it down */
            }
        }, heartbeatMs);
        timer.unref?.();

        // Registered *before* anything is said about it.
        //
        // `isOnline` counts these entries, and this used to happen after the announcement
        // below — so `presence` counted an empty set and told the household that somebody who
        // had just connected was offline. Every connect said so. A phone that hears somebody
        // is offline has no reason to ask again, so the indicator stayed grey until something
        // else moved it, which is why refreshing appeared to flip it. Measured 2026-09-22,
        // from the broadcast the server was already writing down.
        set.set(response, timer);

        store.touchPresence(userId, new Date().toISOString());
        // Always the truth, whether or not this is a change. A client replacing its stream —
        // which a pull-to-refresh does — cancels one and opens another, and the server can
        // see those in either order. A broadcast that only fires on a transition then leaves
        // the last word as whatever arrived second.
        presence(userId, new Date().toISOString());

        return () => {
            clearInterval(timer);
            const current = streams.get(userId);
            if (!current) return;
            current.delete(response);
            if (!current.size) streams.delete(userId);
            // Same reasoning as `add`: the state after the change is what gets sent, not
            // only the moment it crosses zero. A stream that was replaced still counts while
            // the new one is open, so a person who never went offline is not reported as
            // having gone offline.
            presence(userId, new Date().toISOString());
        };
    }

    function close() {
        for (const set of streams.values()) {
            for (const [response, timer] of set) {
                clearInterval(timer);
                try {
                    response.end();
                } catch {
                    /* nothing left to do */
                }
            }
        }
        streams.clear();
    }

    return { add, emit, broadcast, presence, isOnline, onlineUserIds, close, streams };
}

module.exports = { createEventBus };
