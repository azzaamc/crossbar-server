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

function createRequestHandler({ config, store, bus, push, lifecycle, log, clientRoot }) {
    const websocketOrigin = (() => {
        const url = new URL(config.publicOrigin);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return url.origin;
    })();

    function securityHeaders(contentType = '') {
        const headers = {
            'content-security-policy':
                `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; `
                + `connect-src 'self' ${websocketOrigin}; frame-src 'self'; media-src 'self' blob:; `
                + `object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
            'cross-origin-opener-policy': 'same-origin-allow-popups',
            'permissions-policy': 'camera=(self), microphone=(self), display-capture=(self)',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
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

    function currentUser(req) {
        const identity = resolveIdentity(req, config);
        if (!identity) return { identity: null, user: null };
        const user = store.observeIdentity(identity, new Date().toISOString(), {
            autoEnrol: config.autoEnrolIdentities,
        });
        return { identity, user };
    }

    function requireUser(req, res) {
        const { identity, user } = currentUser(req);
        if (!identity) {
            sendError(res, 401, 'IDENTITY_MISSING', 'Open Crossbar through its private Tailscale URL.');
            return null;
        }
        if (!user) {
            sendError(res, 403, 'IDENTITY_NOT_ENROLLED', 'This identity is not a member of this household.');
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
        const root = isCallClient ? clientRoot : config.webRoot;

        if (url.pathname === '/call') relative = 'call/index.html';
        if (url.pathname === '/newcall') relative = 'newcall.html';

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

        const user = requireUser(req, res);
        if (!user) return;

        if (deviceId) store.touchDevice(deviceId, new Date().toISOString());

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
