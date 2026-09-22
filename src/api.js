'use strict';

// The HTTP surface: identity, the directory, call lifecycle, device registration,
// push subscriptions, the event stream, and whatever static files the browser
// clients need.
//
// Every route below `/api/` requires a trusted identity, and every mutation also
// requires an origin that matches (or is absent — a native client sends none).

const fs = require('node:fs');
const path = require('node:path');
const { resolveIdentity, isLoopback } = require('./identity');
const { DEVICE_ID_PATTERN } = require('./db');
const auth = require('./auth');
const { iceConfigFor } = require('./ice');

const MIME = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.woff2': 'font/woff2',
};

const BODY_LIMIT = 16384;

/**
 * What a refusal from `auth.js` means to a client.
 *
 * `DEVICE_AUTH_DISABLED` is a 404 deliberately: a client that finds no `/api/auth/*`
 * should read "this server does not use device authentication", and from the outside
 * that has to look the same as a server that does not implement the routes at all.
 */
const AUTH_STATUS = {
    DEVICE_AUTH_DISABLED: 404,
    ENROLLMENT_INVALID: 401,
    ENROLLMENT_REVOKED: 403,
    ENROLLMENT_USED: 409,
    ENROLLMENT_EXPIRED: 410,
    DEVICE_KEY_INVALID: 400,
    DEVICE_UNKNOWN: 404,
    DEVICE_REVOKED: 403,
    CHALLENGE_INVALID: 401,
    CHALLENGE_EXPIRED: 410,
    SIGNATURE_INVALID: 401,
    USER_UNKNOWN: 404,
    RATE_LIMITED: 429,
};

const AUTH_MESSAGE = {
    DEVICE_AUTH_DISABLED: 'This server does not use device authentication.',
    ENROLLMENT_INVALID: 'That enrolment code is not valid.',
    ENROLLMENT_REVOKED: 'That enrolment code was withdrawn.',
    ENROLLMENT_USED: 'That enrolment code has already been used.',
    ENROLLMENT_EXPIRED: 'That enrolment code has expired.',
    DEVICE_KEY_INVALID: 'That device key is not a P-256 public key.',
    DEVICE_UNKNOWN: 'That device is not enrolled with this server.',
    DEVICE_REVOKED: 'That device has been revoked.',
    CHALLENGE_INVALID: 'That challenge is not valid.',
    CHALLENGE_EXPIRED: 'That challenge has expired.',
    SIGNATURE_INVALID: 'That signature does not match this device.',
    USER_UNKNOWN: 'That person is not in this household.',
    RATE_LIMITED: 'Too many attempts. Try again shortly.',
};

function createRequestHandler({ config, store, bus, push, lifecycle, log, clientRoot }) {
    const websocketOrigin = (() => {
        const url = new URL(config.publicOrigin);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return url.origin;
    })();

    function securityHeaders(contentType = '') {
        const headers = {
            // `frame-ancestors 'self'` rather than 'none': the PWA loads the call
            // client in its call frame, and both are served from this origin. `self`
            // still refuses every other site, which is the protection that matters.
            'content-security-policy':
                `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; `
                + `connect-src 'self' ${websocketOrigin}; frame-src 'self'; media-src 'self' blob:; `
                + `object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`,
            'cross-origin-opener-policy': 'same-origin-allow-popups',
            'permissions-policy': 'camera=(self), microphone=(self), display-capture=(self)',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            // The legacy spelling of the same rule, for anything that does not read CSP.
            'x-frame-options': 'SAMEORIGIN',
        };
        if (contentType) headers['content-type'] = contentType;
        return headers;
    }

    function sendJson(res, status, data) {
        res.writeHead(status, { ...securityHeaders('application/json; charset=utf-8'), 'cache-control': 'no-store' });
        res.end(JSON.stringify(data));
    }

    function sendError(res, status, code, message) {
        sendJson(res, status, { error: { code, message } });
    }

    async function readJson(req) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > BODY_LIMIT) throw Object.assign(new Error('Request body is too large'), { status: 413 });
            chunks.push(chunk);
        }
        if (!chunks.length) return {};
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 });
        }
    }

    /**
     * Who this request is, and how that was decided.
     *
     * A device session wins outright: it is a device that has already answered a
     * challenge, so nothing the transport says can make it more true. Only then is the
     * transport consulted — the identity header a local proxy injects, which means
     * something because the listener is loopback-only and nothing else can reach it.
     */
    function currentUser(req) {
        const now = new Date().toISOString();
        const session = auth.sessionFromRequest(req, { store, config, now });
        if (session) {
            return {
                identity: {
                    source: 'device',
                    name: session.user.displayName,
                    login: session.user.id,
                    deviceId: session.device.id,
                },
                user: session.user,
                device: session.device,
            };
        }
        const identity = resolveIdentity(req, config);
        if (!identity) return { identity: null, user: null, device: null };
        const user = store.observeIdentity(identity, now, { autoEnrol: config.autoEnrolIdentities });
        return { identity, user, device: null };
    }

    /**
     * Who is calling, as far as rate limiting is concerned.
     *
     * Behind the reverse proxy every connection arrives from loopback, so the address
     * that distinguishes anybody is the one the proxy appended. Only the last entry is
     * read: a client may send an `X-Forwarded-For` of its own, and it lands at the
     * front of the list, where it is not believed.
     */
    function clientAddress(req) {
        const direct = req.socket?.remoteAddress || 'unknown';
        if (!isLoopback(direct)) return direct;
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded !== 'string' || !forwarded) return direct;
        return forwarded.split(',').pop().trim() || direct;
    }

    function authFailure(res, reason) {
        sendError(res, AUTH_STATUS[reason] || 400, reason, AUTH_MESSAGE[reason] || 'The request was refused.');
    }

    /** A body that is too large or is not JSON is a refusal, not an exception. */
    async function readJsonOrRefuse(req, res) {
        try {
            const body = await readJson(req);
            return body && typeof body === 'object' ? body : {};
        } catch (error) {
            sendError(res, error.status || 400, 'INVALID_REQUEST', error.message);
            return null;
        }
    }

    function requireUser(req, res) {
        const { identity, user, device } = currentUser(req);
        if (!identity) {
            // A public deployment has no other way in, so it says what is actually
            // missing rather than naming a Tailscale URL that does not apply there.
            if (config.networkMode === 'public') {
                sendError(res, 401, 'DEVICE_AUTH_REQUIRED', 'This device is not enrolled with this server.');
            } else {
                sendError(res, 401, 'IDENTITY_MISSING', 'Open Crossbar through its private Tailscale URL.');
            }
            return null;
        }
        if (!user) {
            sendError(res, 403, 'IDENTITY_NOT_ENROLLED', 'This identity is not a member of this household.');
            return null;
        }
        // Where a device key is required, being reachable is not enough. This is the
        // line that stops "arrived over the tailnet" from meaning "is that person".
        if (config.requireDeviceAuth && !device) {
            sendError(res, 401, 'DEVICE_AUTH_REQUIRED', 'This device is not enrolled with this server.');
            return null;
        }
        return user;
    }

    /** A mutation must not be driven by a page from somewhere else. */
    function checkOrigin(req, res) {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
        const origin = req.headers.origin;
        if (origin && origin !== config.publicOrigin) {
            sendError(res, 403, 'ORIGIN_REJECTED', 'Request origin is not allowed.');
            return false;
        }
        return true;
    }

    function deviceIdOf(req) {
        const value = req.headers['x-crossbar-device'];
        if (typeof value === 'string' && DEVICE_ID_PATTERN.test(value)) return value;
        return null;
    }

    // ── Static ──────────────────────────────────────────────────────────────────

    function streamFile(filePath, res) {
        const extension = path.extname(filePath);
        res.writeHead(200, {
            ...securityHeaders(MIME[extension] || 'application/octet-stream'),
            'cache-control': 'no-cache',
        });
        fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
    }

    function resolveWithin(root, relative) {
        const filePath = path.join(root, relative);
        if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) return null;
        return filePath;
    }

    /**
     * The call client belongs to this server; everything else is the household PWA,
     * which stays where it is while the native path moves over.
     */
    function serveStatic(req, res, url) {
        let relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        if (relative.includes('\0') || relative.split('/').includes('..')) {
            return sendError(res, 400, 'INVALID_PATH', 'Invalid path.');
        }

        const isCallClient = url.pathname === '/call' || url.pathname.startsWith('/call/')
            || url.pathname === '/newcall';
        // The operator console is this server's own too: served from here so it is the
        // same origin as the API it calls, and so it exists even where no household PWA
        // is deployed beside it.
        const isConsole = url.pathname === '/admin' || url.pathname.startsWith('/admin/');
        const root = isConsole ? path.join(clientRoot, 'admin')
            : (isCallClient ? clientRoot : config.webRoot);

        if (url.pathname === '/call') relative = 'call/index.html';
        if (url.pathname === '/newcall') relative = 'newcall.html';
        if (isConsole) relative = url.pathname === '/admin' ? 'index.html' : relative.slice('admin/'.length) || 'index.html';

        const filePath = resolveWithin(root, relative);
        if (!filePath) return sendError(res, 403, 'FORBIDDEN', 'Forbidden.');

        fs.stat(filePath, (error, stat) => {
            if (error || !stat.isFile()) return sendError(res, 404, 'NOT_FOUND', 'File not found.');
            streamFile(filePath, res);
        });
    }

    // ── API ─────────────────────────────────────────────────────────────────────

    async function handleApi(req, res, url) {
        if (!checkOrigin(req, res)) return;

        const pathname = url.pathname;
        const deviceId = deviceIdOf(req);

        if (req.method === 'GET' && pathname === '/api/session') {
            const { identity, user } = currentUser(req);
            return sendJson(res, 200, {
                authenticated: Boolean(identity),
                configured: Boolean(user),
                identity: identity ? { name: user?.displayName || identity.name, source: identity.source } : null,
                user,
                devices: deviceId ? store.devicesFor(user?.id || '') : undefined,
            });
        }

        // ── Health ──────────────────────────────────────────────────────────────
        //
        // Unauthenticated on purpose, so a browser, a monitor or a `curl` can answer
        // "is this server up" before anything else works. It says which mode this is
        // and nothing an unwelcome visitor could use.
        if (req.method === 'GET' && pathname === '/api/health') {
            return sendJson(res, 200, { status: 'ok', mode: config.networkMode });
        }

        // ── Device identity ─────────────────────────────────────────────────────
        //
        // The only routes reached without a session, because they are how a session is
        // obtained. Each is limited by address as well as by device: an invitation code
        // is high-entropy, but a server that answers unlimited guesses is a server that
        // is one bad code away from being somebody else's.
        if (req.method === 'POST' && pathname === '/api/auth/enroll') {
            if (!lifecycle.limiter.take(`enroll:${clientAddress(req)}`, 10, 60000)) {
                return authFailure(res, 'RATE_LIMITED');
            }
            const body = await readJsonOrRefuse(req, res);
            if (!body) return;
            const result = auth.enroll({
                store,
                config,
                now: new Date().toISOString(),
                token: body.token,
                publicKey: body.publicKey,
                algorithm: body.algorithm,
                deviceName: body.deviceName,
                platform: body.platform,
                // Where the device arrived from, when that is something we know. It
                // becomes an authenticator on the new device, never the device itself.
                transportIdentity: resolveIdentity(req, config),
            });
            if (!result.ok) return authFailure(res, result.reason);
            log.info('device_enrolled', {
                deviceId: result.device.id,
                userId: result.user.id,
                platform: result.device.platform,
            });
            return sendJson(res, 200, {
                device: {
                    id: result.device.id,
                    name: result.device.label,
                    platform: result.device.platform,
                },
                user: { id: result.user.id, displayName: result.user.displayName },
                session: result.session,
            });
        }

        if (req.method === 'POST' && pathname === '/api/auth/challenge') {
            const body = await readJsonOrRefuse(req, res);
            if (!body) return;
            const deviceId = String(body.deviceId || '');
            if (!lifecycle.limiter.take(`challenge:${deviceId}`, 20, 60000)
                || !lifecycle.limiter.take(`challenge-ip:${clientAddress(req)}`, 60, 60000)) {
                return authFailure(res, 'RATE_LIMITED');
            }
            const result = auth.challenge({ store, config, now: new Date().toISOString(), deviceId });
            if (!result.ok) return authFailure(res, result.reason);
            return sendJson(res, 200, {
                challengeId: result.challengeId,
                nonce: result.nonce,
                expiresAt: result.expiresAt,
            });
        }

        if (req.method === 'POST' && pathname === '/api/auth/session') {
            const body = await readJsonOrRefuse(req, res);
            if (!body) return;
            const deviceId = String(body.deviceId || '');
            if (!lifecycle.limiter.take(`session:${deviceId}`, 30, 60000)) {
                return authFailure(res, 'RATE_LIMITED');
            }
            const result = auth.completeSession({
                store,
                config,
                now: new Date().toISOString(),
                deviceId,
                challengeId: body.challengeId,
                signature: body.signature,
            });
            if (!result.ok) return authFailure(res, result.reason);
            return sendJson(res, 200, {
                device: { id: result.device.id, name: result.device.label },
                user: { id: result.user.id, displayName: result.user.displayName },
                session: result.session,
            });
        }

        const user = requireUser(req, res);
        if (!user) return;

        if (deviceId) store.touchDevice(deviceId, new Date().toISOString());

        // ── This device ─────────────────────────────────────────────────────────
        //
        // What a device may know about itself: its identity and the other ways this
        // server recognises it. Not its key material — a device already holds the only
        // part of that which matters.
        if (req.method === 'GET' && pathname === '/api/device') {
            const { device, identity } = currentUser(req);
            if (!device) {
                return sendJson(res, 200, {
                    enrolled: false,
                    via: identity?.source || null,
                    mode: config.networkMode,
                });
            }
            return sendJson(res, 200, {
                enrolled: true,
                device: {
                    id: device.id,
                    name: device.label,
                    platform: device.platform,
                    createdAt: device.createdAt,
                },
                authenticators: store.authenticatorsForDevice(device.id).map((item) => ({
                    type: item.type,
                    subject: item.externalSubject,
                    createdAt: item.createdAt,
                    lastVerifiedAt: item.lastVerifiedAt,
                    revokedAt: item.revokedAt,
                })),
                mode: config.networkMode,
            });
        }

        // ── Where to send media ─────────────────────────────────────────────────
        //
        // Credentials that expire, handed to a device that has proved itself. A client
        // never carries a relay password it could leak, and the operator can change the
        // relay's secret without touching a single phone.
        if (req.method === 'GET' && pathname === '/api/webrtc/ice') {
            const { device } = currentUser(req);
            return sendJson(res, 200, iceConfigFor({
                config,
                now: new Date().toISOString(),
                name: device?.id || user.id,
            }));
        }

        // ── Administration ──────────────────────────────────────────────────────
        //
        // Admitting a phone and taking one away is something a household has to be able
        // to do, and the person who does it is the one the household file marks as an
        // administrator. There is no second kind of account and no admin UI: the CLI
        // drives these same routes, and the same identity rules apply to both.
        if (pathname.startsWith('/api/admin/')) {
            if (!user.admin) {
                return sendError(res, 403, 'NOT_ADMIN', 'Only an administrator may manage devices.');
            }

            /** A device as an operator sees it. The public key is not part of that. */
            function adminDevice(device) {
                return {
                    id: device.id,
                    userId: device.userId,
                    userName: device.userName,
                    label: device.label,
                    platform: device.platform,
                    status: device.status,
                    algorithm: device.keyAlgorithm || null,
                    hasKey: Boolean(device.hasKey ?? device.publicKey),
                    hasPushToken: Boolean(device.hasPushToken),
                    createdAt: device.createdAt,
                    lastSeenAt: device.lastSeenAt,
                    revokedAt: device.revokedAt || null,
                };
            }

            if (req.method === 'GET' && pathname === '/api/admin/status') {
                const now = new Date().toISOString();
                return sendJson(res, 200, {
                    mode: config.networkMode,
                    hostname: config.publicHostname || null,
                    origin: config.publicOrigin,
                    requireDeviceAuth: config.requireDeviceAuth,
                    deviceAuthEnabled: Boolean(config.sessionSecret),
                    turn: config.turn?.host
                        ? {
                            host: config.turn.host,
                            port: config.turn.port,
                            relayPorts: [config.turn.minPort, config.turn.maxPort],
                            ttlSeconds: config.turn.ttlSeconds,
                        }
                        : null,
                    users: store.listUsers().length,
                    devices: store.allDevices().length,
                    openEnrollments: store.enrollments(now).filter((item) => item.state === 'open').length,
                });
            }

            if (req.method === 'GET' && pathname === '/api/admin/users') {
                return sendJson(res, 200, { users: store.listUsers() });
            }

            if (req.method === 'GET' && pathname === '/api/admin/devices') {
                return sendJson(res, 200, { devices: store.allDevices().map(adminDevice) });
            }

            if (req.method === 'GET' && pathname === '/api/admin/enrollments') {
                return sendJson(res, 200, { enrollments: store.enrollments(new Date().toISOString()) });
            }

            if (req.method === 'POST' && pathname === '/api/admin/enrollments') {
                const body = await readJsonOrRefuse(req, res);
                if (!body) return;
                const result = auth.createInvitation({
                    store,
                    config,
                    now: new Date().toISOString(),
                    userId: String(body.userId || ''),
                    createdBy: user.id,
                    ttlSeconds: Number(body.ttlSeconds) || null,
                });
                if (!result.ok) return authFailure(res, result.reason);
                log.info('enrollment_created', {
                    enrollmentId: result.enrollment.id,
                    intendedUserId: result.enrollment.intendedUserId,
                    createdBy: user.id,
                });
                // The plaintext token is in this response and nowhere else; only its
                // hash exists server-side, so it cannot be read back later.
                return sendJson(res, 201, {
                    enrollment: {
                        id: result.enrollment.id,
                        expiresAt: result.enrollment.expiresAt,
                        intendedUserId: result.enrollment.intendedUserId,
                    },
                    payload: result.payload,
                });
            }

            const deviceMatch = pathname.match(/^\/api\/admin\/devices\/([A-Za-z0-9_-]{8,64})\/(revoke|rename)$/);
            if (req.method === 'POST' && deviceMatch) {
                const target = store.deviceIdentity(deviceMatch[1]);
                if (!target) return sendError(res, 404, 'DEVICE_UNKNOWN', 'That device is not enrolled with this server.');
                const now = new Date().toISOString();
                if (deviceMatch[2] === 'revoke') {
                    store.revokeDevice(target.id, now);
                    log.info('device_revoked', { deviceId: target.id, userId: target.userId, by: user.id });
                    return sendJson(res, 200, { device: adminDevice(store.deviceIdentity(target.id)) });
                }
                const body = await readJsonOrRefuse(req, res);
                if (!body) return;
                store.renameDevice(target.id, body.label, now);
                return sendJson(res, 200, { device: adminDevice(store.deviceIdentity(target.id)) });
            }

            const enrollmentMatch = pathname.match(/^\/api\/admin\/enrollments\/(enr_[A-Za-z0-9_-]{1,32})\/revoke$/);
            if (req.method === 'POST' && enrollmentMatch) {
                const revoked = store.revokeEnrollment(enrollmentMatch[1], new Date().toISOString());
                if (!revoked) return sendError(res, 404, 'ENROLLMENT_INVALID', 'That enrolment code is not open.');
                log.info('enrollment_revoked', { enrollmentId: enrollmentMatch[1], by: user.id });
                return sendJson(res, 200, { revoked: true });
            }

            return sendError(res, 404, 'NOT_FOUND', 'No such administrative route.');
        }

        if (req.method === 'GET' && pathname === '/api/bootstrap') {
            const contacts = store.contactsFor(user.id).map((contact) => ({
                ...contact,
                online: bus.isOnline(contact.id),
            }));
            return sendJson(res, 200, {
                user,
                contacts,
                groups: store.groupsFor(user.id),
                calls: store.callsForUser(user.id),
                ongoingCalls: deviceId
                    ? store.ongoingCallsForDevice(deviceId).map(lifecycle.publicCall)
                    : store.ongoingCallsForUser(user.id).map(lifecycle.publicCall),
            });
        }

        if (req.method === 'GET' && pathname === '/api/push/config') {
            return sendJson(res, 200, { enabled: push.enabled, publicKey: push.publicKey });
        }

        if (req.method === 'POST' && pathname === '/api/devices') {
            const body = await readJson(req);
            try {
                const device = store.registerDevice({
                    userId: user.id,
                    deviceId: String(body.deviceId || ''),
                    label: body.label,
                    platform: body.platform,
                    now: new Date().toISOString(),
                });
                log.info('device_registered', { userId: user.id, deviceId: device.id });
                return sendJson(res, 201, { device });
            } catch (error) {
                return sendError(res, 400, 'INVALID_DEVICE', error.message);
            }
        }

        if (req.method === 'POST' && pathname === '/api/devices/push-token') {
            const body = await readJson(req);
            const id = String(body.deviceId || '');
            const device = store.deviceById(id);
            if (!device || device.userId !== user.id) {
                return sendError(res, 404, 'DEVICE_NOT_FOUND', 'That device is not registered to you.');
            }
            store.savePushToken({
                deviceId: id,
                token: String(body.token || ''),
                environment: String(body.environment || 'production'),
                now: new Date().toISOString(),
            });
            return sendJson(res, 200, { saved: true });
        }

        if (req.method === 'POST' && pathname === '/api/push/subscriptions') {
            if (!push.enabled) return sendError(res, 503, 'PUSH_NOT_CONFIGURED', 'Notifications are not configured.');
            if (!lifecycle.limiter.take(`${user.id}:push`, 12, 60000)) {
                return sendError(res, 429, 'RATE_LIMITED', 'Please wait and try again.');
            }
            const body = await readJson(req);
            try {
                store.savePushSubscription(user.id, body.subscription, new Date().toISOString());
                return sendJson(res, 201, { subscribed: true });
            } catch (error) {
                return sendError(res, 400, 'INVALID_SUBSCRIPTION', error.message);
            }
        }

        if (req.method === 'DELETE' && pathname === '/api/push/subscriptions') {
            const body = await readJson(req);
            const endpoint = String(body.endpoint || '');
            if (!endpoint || endpoint.length > 4096) {
                return sendError(res, 400, 'INVALID_SUBSCRIPTION', 'A valid subscription is required.');
            }
            store.deletePushSubscription(user.id, endpoint);
            return sendJson(res, 200, { subscribed: false });
        }

        if (req.method === 'GET' && pathname === '/api/events') {
            res.writeHead(200, {
                ...securityHeaders('text/event-stream; charset=utf-8'),
                'cache-control': 'no-cache, no-transform',
                connection: 'keep-alive',
                'x-accel-buffering': 'no',
            });
            res.write(`event: ready\ndata: ${JSON.stringify({ userId: user.id })}\n\n`);
            const remove = bus.add(user.id, res);
            req.on('close', remove);
            return;
        }

        if (req.method === 'GET' && pathname === '/api/calls') {
            return sendJson(res, 200, { calls: store.callsForUser(user.id) });
        }

        if (req.method === 'POST' && pathname === '/api/calls') {
            const body = await readJson(req);
            const result = lifecycle.createCall({
                user,
                inviteeIds: body.inviteeIds,
                deviceId,
                kind: body.kind === 'audio' ? 'audio' : 'video',
            });
            if (!result.ok) return sendError(res, refusalStatus(result.reason), result.reason, refusalMessage(result.reason));
            return sendJson(res, 201, lifecycle.envelope(result.call));
        }

        const groupMatch = pathname.match(/^\/api\/groups\/([a-z0-9_-]+)\/calls$/i);
        if (req.method === 'POST' && groupMatch) {
            const invitees = store.groupInvitees(groupMatch[1], user.id);
            if (!invitees.length) return sendError(res, 404, 'GROUP_NOT_FOUND', 'No callable group was found.');
            const result = lifecycle.createCall({ user, inviteeIds: invitees.map((item) => item.id), deviceId });
            if (!result.ok) return sendError(res, refusalStatus(result.reason), result.reason, refusalMessage(result.reason));
            return sendJson(res, 201, lifecycle.envelope(result.call));
        }

        const callMatch = pathname.match(/^\/api\/calls\/([0-9a-f-]+)$/i);
        if (req.method === 'GET' && callMatch) {
            const call = store.callById(callMatch[1]);
            if (!call || !store.participant(call.id, user.id)) {
                return sendError(res, 404, 'CALL_NOT_FOUND', 'Call was not found.');
            }
            return sendJson(res, 200, { call: lifecycle.publicCall(call) });
        }

        const respondMatch = pathname.match(/^\/api\/calls\/([0-9a-f-]+)\/respond$/i);
        if (req.method === 'POST' && respondMatch) {
            const body = await readJson(req);
            const result = lifecycle.respond({
                user,
                callId: respondMatch[1],
                response: body.response,
                deviceId,
            });
            if (!result.ok) return sendError(res, refusalStatus(result.reason), result.reason, refusalMessage(result.reason));
            return sendJson(res, 200, result.declined
                ? { call: lifecycle.publicCall(result.call) }
                : lifecycle.envelope(result.call));
        }

        const inviteMatch = pathname.match(/^\/api\/calls\/([0-9a-f-]+)\/invite$/i);
        if (req.method === 'POST' && inviteMatch) {
            const body = await readJson(req);
            const result = lifecycle.invite({
                user,
                callId: inviteMatch[1],
                inviteeIds: body.inviteeIds,
                deviceId,
            });
            if (!result.ok) return sendError(res, refusalStatus(result.reason), result.reason, refusalMessage(result.reason));
            return sendJson(res, 200, { call: lifecycle.publicCall(result.call), added: result.added });
        }

        const joinMatch = pathname.match(/^\/api\/calls\/([0-9a-f-]+)\/join$/i);
        if (req.method === 'POST' && joinMatch) {
            const result = lifecycle.join({ user, callId: joinMatch[1], deviceId });
            if (!result.ok) return sendError(res, refusalStatus(result.reason), result.reason, refusalMessage(result.reason));
            return sendJson(res, 200, lifecycle.envelope(result.call));
        }

        const leaveMatch = pathname.match(/^\/api\/calls\/([0-9a-f-]+)\/leave$/i);
        if (req.method === 'POST' && leaveMatch) {
            const result = lifecycle.leave({ user, callId: leaveMatch[1], deviceId });
            if (!result.ok) return sendError(res, refusalStatus(result.reason), result.reason, refusalMessage(result.reason));
            return sendJson(res, 200, { call: lifecycle.publicCall(result.call), ended: result.ended });
        }

        const endMatch = pathname.match(/^\/api\/calls\/([0-9a-f-]+)\/end$/i);
        if (req.method === 'POST' && endMatch) {
            const result = lifecycle.end({ user, callId: endMatch[1] });
            if (!result.ok) return sendError(res, refusalStatus(result.reason), result.reason, refusalMessage(result.reason));
            return sendJson(res, 200, { call: lifecycle.publicCall(result.call) });
        }

        return sendError(res, 404, 'NOT_FOUND', 'API endpoint not found.');
    }

    function refusalStatus(reason) {
        switch (reason) {
            case 'RATE_LIMITED': return 429;
            case 'CALL_NOT_FOUND':
            case 'GROUP_NOT_FOUND': return 404;
            case 'CONTACT_NOT_ALLOWED': return 403;
            case 'INVALID_INVITEES':
            case 'INVALID_RESPONSE':
            case 'INVALID_DEVICE': return 400;
            default: return 409;
        }
    }

    function refusalMessage(reason) {
        switch (reason) {
            case 'RATE_LIMITED': return 'Please wait before trying again.';
            case 'INVALID_INVITEES': return 'Choose one or more family contacts.';
            case 'CONTACT_NOT_ALLOWED': return 'One or more invitees are not configured contacts.';
            case 'INVALID_RESPONSE': return 'Response must be accepted or declined.';
            case 'CALL_NOT_FOUND': return 'Call was not found.';
            case 'CALL_EXPIRED': return 'This call is no longer available.';
            case 'ALREADY_RESPONDED': return 'This invitation has already been answered.';
            case 'CALL_NOT_JOINABLE': return 'This call is not available to join.';
            case 'NOT_A_PARTICIPANT': return 'You are not a participant of this call.';
            case 'NOT_IN_CALL': return 'You are not in this call.';
            default: return 'The call could not be completed.';
        }
    }

    return async function handler(req, res) {
        try {
            const url = new URL(req.url, config.publicOrigin);

            // Development-only identity selection. A browser cannot set a header on a
            // WebSocket handshake, so on a laptop the identity has to arrive as a
            // cookie. This route exists only when loopback development identity is
            // switched on, and it can only name an identity that is already allowed.
            if (url.pathname === '/dev/identity') {
                if (!config.allowDevIdentity) {
                    return sendError(res, 404, 'NOT_FOUND', 'Not found.');
                }
                const login = String(url.searchParams.get('login') || '').trim().toLowerCase();
                if (!login || (config.devIdentities.length && !config.devIdentities.includes(login))) {
                    return sendError(res, 400, 'INVALID_IDENTITY', 'That identity is not available.');
                }
                res.writeHead(302, {
                    'set-cookie': `crossbar.dev.identity=${encodeURIComponent(login)}; Path=/; SameSite=Lax`,
                    location: url.searchParams.get('next') || '/',
                    'cache-control': 'no-store',
                });
                return res.end();
            }

            if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
            if (!['GET', 'HEAD'].includes(req.method)) {
                return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
            }
            return serveStatic(req, res, url);
        } catch (error) {
            const status = error.status || 500;
            if (status >= 500) log.error('request_error', { message: String(error.message).slice(0, 200) });
            return sendError(
                res,
                status,
                status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
                status >= 500 ? 'Crossbar could not complete that request.' : error.message,
            );
        }
    };
}

module.exports = { createRequestHandler, MIME, isLoopback };
