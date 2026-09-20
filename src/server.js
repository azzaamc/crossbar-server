'use strict';

// Composition root: one process, one SQLite file, one HTTP listener that also
// carries the signalling upgrade.
//
// Nothing here holds state of its own — every module it builds is handed what it
// needs, which is what makes the whole server startable inside a test on an
// ephemeral port.

const http = require('node:http');
const path = require('node:path');
const { loadConfig } = require('./config');
const { createLogger } = require('./log');
const { Store } = require('./db');
const { createEventBus } = require('./events');
const { createPushNotifier } = require('./push');
const { createLifecycle } = require('./lifecycle');
const { createRequestHandler } = require('./api');
const { createSignalServer } = require('./signal');

const EXPIRY_SWEEP_MS = 10000;

function createCrossbarServer({ config = loadConfig(), log } = {}) {
    const logger = log || createLogger({ level: config.nodeEnv === 'production' ? 'info' : 'debug' });

    const store = new Store(config.dataDir, config.familyConfigPath);
    const bus = createEventBus({ store, log: logger });
    const push = createPushNotifier({ config, log: logger });
    const lifecycle = createLifecycle({ config, store, bus, push, log: logger });

    const clientRoot = path.join(__dirname, '..', 'public');
    const handler = createRequestHandler({ config, store, bus, push, lifecycle, log: logger, clientRoot });
    const httpServer = http.createServer(handler);

    // Upgraded sockets are not covered by `closeAllConnections`, and `close()` waits
    // for every socket — so they are tracked here and destroyed on shutdown, or the
    // process would hang waiting for a client that has stopped answering.
    const sockets = new Set();
    httpServer.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });

    const signal = createSignalServer({
        config,
        store,
        log: logger,
        onAdmitted: (_session, call) => {
            if (call) {
                lifecycle.emitToParticipants(call);
                lifecycle.announceOngoing(call);
            }
        },
        onClosed: (session, reason) => {
            if (!session.admitted) return;
            lifecycle.deviceLeftBySocket({
                callId: session.callId,
                userId: session.userId,
                deviceId: session.deviceId,
                peerId: session.id,
                reason,
            });
        },
    });
    signal.attach(httpServer);

    const expiryTimer = setInterval(() => {
        try {
            lifecycle.expire();
        } catch (error) {
            logger.error('expiry_sweep_failed', { message: String(error && error.message).slice(0, 200) });
        }
    }, EXPIRY_SWEEP_MS);
    expiryTimer.unref?.();

    let listening = null;

    function listen() {
        return new Promise((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(config.port, config.host, () => {
                httpServer.removeListener('error', reject);
                listening = httpServer.address();
                logger.info('crossbar_started', {
                    host: config.host,
                    port: listening.port,
                    origin: config.publicOrigin,
                    iceServers: config.iceServers.map((server) => server.urls),
                    push: push.enabled,
                    // Deliberately labelled, never valued: what is configured is
                    // operationally useful, what it contains is not log material.
                    secrets: {
                        vapid: Boolean(config.vapidPublicKey && config.vapidPrivateKey),
                    },
                    limits: {
                        maxParticipants: config.maxParticipants,
                        messageBytes: config.messageBytes,
                        ringSeconds: config.callRingSeconds,
                    },
                });
                resolve(listening);
            });
        });
    }

    function close() {
        clearInterval(expiryTimer);

        // Every device still in a call is closed out before the store goes away, so
        // a restart does not leave rows claiming people are in calls they have left.
        for (const room of signal.snapshot()) {
            for (const peer of room.peers) {
                try {
                    lifecycle.deviceLeftBySocket({
                        callId: peer.callId,
                        userId: peer.userId,
                        deviceId: peer.deviceId,
                        peerId: peer.id,
                        reason: 'shutdown',
                    });
                } catch (error) {
                    logger.warn('shutdown_leave_failed', { message: String(error && error.message).slice(0, 120) });
                }
            }
        }

        signal.close();
        bus.close();
        return new Promise((resolve) => {
            httpServer.close(() => {
                store.close();
                resolve();
            });
            httpServer.closeAllConnections?.();
            for (const socket of sockets) socket.destroy();
            sockets.clear();
        });
    }

    return {
        config,
        log: logger,
        store,
        bus,
        push,
        lifecycle,
        signal,
        httpServer,
        listen,
        close,
        get address() {
            return listening;
        },
    };
}

// Direct execution: `node src/server.js`
if (require.main === module) {
    const server = createCrossbarServer();
    server.listen().catch((error) => {
        server.log.error('crossbar_start_failed', { message: String(error && error.message).slice(0, 200) });
        process.exitCode = 1;
    });

    let stopping = false;
    function shutdown(signalName) {
        if (stopping) return;
        stopping = true;
        server.log.info('crossbar_stopping', { signal: signalName });
        server.close().then(
            () => process.exit(0),
            () => process.exit(1),
        );
        setTimeout(() => process.exit(1), 5000).unref();
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // A signalling server must not be killable by a message. Belt and braces: the
    // handlers are already wrapped, and if anything still escapes, it is logged and
    // the process keeps serving rather than dropping every live call.
    process.on('unhandledRejection', (reason) => {
        server.log.error('unhandled_rejection', { message: String(reason && reason.message || reason).slice(0, 200) });
    });
    process.on('uncaughtException', (error) => {
        server.log.error('uncaught_exception', { message: String(error && error.message).slice(0, 200) });
    });
}

module.exports = { createCrossbarServer };
