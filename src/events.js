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
        for (const recipientId of streams.keys()) emit(recipientId, 'presence', payload);
    }

    /** Registers a stream and returns the function that removes it again. */
    function add(userId, response) {
        let set = streams.get(userId);
        const wasOffline = !set || set.size === 0;
        if (!set) {
            set = new Map();
            streams.set(userId, set);
        }
        store.touchPresence(userId, new Date().toISOString());
        if (wasOffline) presence(userId, new Date().toISOString());

        const timer = setInterval(() => {
            store.touchPresence(userId, new Date().toISOString());
            try {
                response.write(': heartbeat\n\n');
            } catch {
                /* the close handler tears it down */
            }
        }, heartbeatMs);
        timer.unref?.();

        set.set(response, timer);

        return () => {
            clearInterval(timer);
            const current = streams.get(userId);
            if (!current) return;
            current.delete(response);
            if (!current.size) {
                streams.delete(userId);
                presence(userId, new Date().toISOString());
            }
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
