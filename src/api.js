'use strict';

// The HTTP surface: identity, the directory, call lifecycle, device registration,
// push subscriptions, the event stream, and whatever static files the browser
// clients need.
//
// Every route below `/api/` requires a trusted identity, and every mutation also
// requires an origin that matches (or is absent — a native client sends none).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MODES, KNOBS, modeBlock, modeConfigured, applyMode, applyKnobs, verifyEnvFile, writeEnvFile } = require('./config');
const { resolveIdentity, isLoopback, isOperatorRequest } = require('./identity');
const { DEVICE_ID_PATTERN } = require('./db');
const auth = require('./auth');
const directoryFile = require('./directory');
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
    OPERATOR_DISABLED: 404,
    PASSWORD_INVALID: 401,
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
    USER_UNKNOWN: 'That person is not in this directory.',
    OPERATOR_DISABLED: 'This server has no console password set.',
    PASSWORD_INVALID: 'That password is not the one for this server.',
    RATE_LIMITED: 'Too many attempts. Try again shortly.',
};

function createRequestHandler({ config, store, bus, push, apns, relay, lifecycle, log, clientRoot }) {
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

    function sendJson(res, status, data, extra = {}) {
        res.writeHead(status, {
            ...securityHeaders('application/json; charset=utf-8'),
            'cache-control': 'no-store',
            ...extra,
        });
        res.end(JSON.stringify(data));
    }

    /**
     * The operator's session, as a cookie the console's own script cannot read.
     *
     * `SameSite=Strict`, because nothing but this site should be able to make a browser
     * send it. `Secure` only where the origin is https: a deployment running on plain
     * loopback would otherwise never receive the cookie it had just been given.
     */
    function operatorCookie(token, { clear = false } = {}) {
        const parts = [
            `${auth.OPERATOR_COOKIE}=${clear ? '' : token}`,
            'Path=/', 'HttpOnly', 'SameSite=Strict',
        ];
        if (config.publicOrigin.startsWith('https:')) parts.push('Secure');
        if (clear) parts.push('Max-Age=0');
        return parts.join('; ');
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

    // ── The push relay, which is what rings a phone ────────────────────────────────
    //
    // A VoIP token arrives here through `POST /api/devices/push-token` and is of no use to
    // this server: the push is sent by the relay, which is the party holding the Apple key
    // for the shared app identity. So the token is registered there against the same opaque
    // device id, which is the one thing that has to be kept in step (relay
    // docs/BACKEND_INTEGRATION.md, "The lifecycle").

    /**
     * How a relay attempt must be read, which is now part of what the routes answer.
     *
     * `saved`/`removed` is the end state reached. `retryable` means the same request sent
     * again could yet succeed: it never arrived (`status: 0`), the relay answered 5xx or 429,
     * another attempt holds the idempotency claim, or this deployment has no relay configured
     * yet — a setting an operator can add, which is why it is retryable rather than a fact.
     * `permanent` is a refusal asking again cannot change, which in this vocabulary is
     * `409 token_conflict`: some other installation owns the token.
     *
     * Retryability is decided here rather than read off the client's `permanent` because that
     * flag answers a different question. For a *ring* a relay that is broken is worth giving
     * up on; for a *registration* the phone repeats anyway a 5xx is worth retrying, and 5xx is
     * exactly where the two answers differ.
     */
    const RETRYABLE_LOCAL_ERRORS = new Set(['not_configured', 'unreachable']);

    function retryableOrPermanent(outcome) {
        // A refusal this process made without asking the relay carries status 0 too, so the
        // status alone cannot tell "no relay configured" from "the token was never a token".
        if (outcome.status === 0) return RETRYABLE_LOCAL_ERRORS.has(String(outcome.error)) ? 'retryable' : 'permanent';
        if (outcome.status >= 500 || outcome.status === 429) return 'retryable';
        if (outcome.status === 409 && outcome.error === 'request_in_progress') return 'retryable';
        return 'permanent';
    }

    /**
     * The relay's answer, as the route that asked for it must report it.
     *
     * Nothing here is the credential, the token or the relay's body: `error` is the relay's own
     * code, which is what an operator acts on and what an app branches on, and it is the same
     * vocabulary the ring path logs.
     */
    function relayReport(outcome, endState) {
        if (!outcome || outcome.error === 'not_configured') {
            return {
                configured: false, ok: false, outcome: 'retryable', status: 0,
                error: 'not_configured', retryAfterSeconds: null,
            };
        }
        // A device the relay does not have answers `404`, which for a removal is the end state:
        // either it never had it or this already happened (relay docs/API.md).
        if (endState === 'removed' && outcome.status === 404) {
            return {
                configured: true, ok: true, outcome: 'removed', status: 404,
                error: outcome.error || null, retryAfterSeconds: null,
            };
        }
        return {
            configured: true,
            ok: outcome.ok,
            outcome: outcome.ok ? endState : retryableOrPermanent(outcome),
            status: outcome.status,
            error: outcome.error || null,
            retryAfterSeconds: outcome.retryAfterSeconds ?? null,
        };
    }

    /**
     * Makes a phone ringable: registers its VoIP token with the relay.
     *
     * The token is stored locally either way, and that is the point of the two answers being
     * separate. `saved` is this server's row; `relay` is whether a call can reach the phone,
     * and it is the whole of what the app needs to decide whether to keep the token pending
     * and try again (SEC-RELAY-07, REL-RELAY-01). A deployment with no relay is refused inside
     * the client, which is the one place that knows.
     */
    async function registerAtRelay(deviceId, token) {
        return relayReport(await relay.registerDevice({ deviceId, token }), 'saved');
    }

    /**
     * Tells the relay a device is gone, so its token stops being ringable here and is free
     * for whoever owns it next.
     *
     * The durable half lives in the lifecycle (REL-RELAY-03): the intent is written down
     * before the request is made, the request is attempted now, and an answer that is neither
     * a `2xx` nor a `404` leaves the intent for the sweep to retry — a deletion whose reply
     * was lost leaves the relay holding the token, and the phone can be rung by nobody until
     * it is released. Nothing about the local row depends on the answer: the row is the fact.
     * What the answer is for is the caller, who gets it back as it was answered.
     */
    async function forgetAtRelay(deviceId) {
        const { outcome } = await lifecycle.forgetDeviceAtRelay(deviceId);
        return relayReport(outcome, 'removed');
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
            sendError(res, 403, 'IDENTITY_NOT_ENROLLED', 'This identity is not a member of this directory.');
            return null;
        }
        // Where a device key is required, being reachable is not enough. This is the
        // line that stops "arrived over the tailnet" from meaning "is that person".
        //
        // The operator's own tooling is the exception, and only from loopback with the
        // derived token: public mode demands a device key of every client, and the CLI is
        // the box talking to itself rather than a client — a refusal here would leave the
        // deployment unable to test itself exactly when it most needs to. A request with no
        // token, or a wrong one, still reaches this line and is refused as before.
        if (config.requireDeviceAuth && !device && !isOperatorRequest(req, config)) {
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
     * The call client belongs to this server; everything else is the directory PWA,
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
        // same origin as the API it calls, and so it exists even where no directory PWA
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
            // The version is here because it is the one question nothing else answers: the
            // CLI can be a shell's checkout and the file can be anything, so the running
            // process is the only thing that knows what it is.
            //
            // `origin` is here so a device can find this server after it moves. It is the
            // address this process believes it is reached at, and it is answered without a
            // credential on purpose: a phone whose stored address is the old one has no way to
            // authenticate -- the old door may be gone -- and the one thing it can still do is
            // ask the address it has. A switch keeps that door open long enough for exactly
            // this question to be asked, which is what stops a moved server costing every
            // person a new invitation code. Nothing secret is in it: the deployment's own
            // address is what any client that can reach it already knows.
            return sendJson(res, 200, {
                status: 'ok',
                mode: config.networkMode,
                version: require('../package.json').version,
                origin: config.publicOrigin,
            });
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

        // ── The operator's way in ─────────────────────────────────────────────────
        //
        // Above the device check on purpose: these two are how a browser with no key and no
        // session gets one, and a route that demanded a session first could never be used by
        // anyone who needs it. The only route that takes a password, and it is not an
        // account — no username, nothing to enumerate, and the same answer whether the
        // password is wrong or none has been set. Rate limited by address, because a shared
        // secret with no limit is a shared secret somebody eventually finds.
        if (req.method === 'POST' && pathname === '/api/admin/session') {
            if (!lifecycle.limiter.take(`operator:${clientAddress(req)}`, 5, 60000)) {
                return authFailure(res, 'RATE_LIMITED');
            }
            const body = await readJsonOrRefuse(req, res);
            if (!body) return;
            const result = auth.openOperatorSession({
                config,
                now: new Date().toISOString(),
                password: String(body.password || ''),
            });
            if (!result.ok) {
                log.warn('operator_login_refused', { from: clientAddress(req) });
                return authFailure(res, result.reason);
            }
            log.info('operator_login', { from: clientAddress(req) });
            return sendJson(res, 200, { ok: true, expiresAt: result.session.expiresAt },
                { 'set-cookie': operatorCookie(result.session.token) });
        }

        // Closing a session only ever takes something away, so it needs no privilege, and
        // it has to work from a browser whose session has already stopped being accepted.
        if (req.method === 'POST' && pathname === '/api/admin/signout') {
            return sendJson(res, 200, { ok: true }, { 'set-cookie': operatorCookie('', { clear: true }) });
        }

        // The operator's session answers for the administrative routes and nothing else, so
        // it is resolved here: a browser holding it has no device, and `requireUser` would
        // refuse it on the way in — which is the friction this exists to remove.
        const isAdminRoute = pathname.startsWith('/api/admin/');
        const operator = isAdminRoute
            ? auth.operatorFromRequest(req, { config, now: new Date().toISOString() })
            : null;

        const user = operator ? null : requireUser(req, res);
        if (!operator && !user) return;

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

        // ── Adding another device ───────────────────────────────────────────────
        //
        // Somebody already enrolled on one device enrolling their next one, with nobody in
        // between. The invitation is minted for the person this device already is and for
        // nobody else, so a device cannot hand out identity: the most it can do is add
        // another way in to its own.
        //
        // Short-lived and limited per person rather than per device, so reaching the limit
        // is not something a third phone gets round. A code made here is made in a hurry,
        // shown on a screen and often read out loud; one that outlived the sitting could be
        // photographed later off a screen somebody had put down.
        if (req.method === 'POST' && pathname === '/api/devices/enrollment') {
            // The device the session belongs to, not one the request names: what an
            // invitation is minted against must be something this server proved.
            const { device } = currentUser(req);
            if (!device) {
                return sendError(res, 409, 'DEVICE_REQUIRED',
                    'This device is recognised by the network it is on rather than by a key, '
                    + 'so it has no enrolment to pass on. Another device on the same network '
                    + 'is recognised the same way it is.');
            }
            if (!lifecycle.limiter.take(`device-enrollment:${user.id}`, 5, 60000)) {
                return sendError(res, 429, 'RATE_LIMITED', 'Please wait before trying again.');
            }
            const result = auth.createInvitation({
                store,
                config,
                now: new Date().toISOString(),
                userId: user.id,
                createdBy: device.id,
                ttlSeconds: Math.min(config.enrollmentTtlSeconds, 900),
            });
            if (!result.ok) return authFailure(res, result.reason);
            log.info('device_enrollment_created', {
                enrollmentId: result.enrollment.id,
                intendedUserId: result.enrollment.intendedUserId,
                deviceId: device.id,
            });
            return sendJson(res, 201, {
                enrollment: {
                    id: result.enrollment.id,
                    expiresAt: result.enrollment.expiresAt,
                    intendedUserId: result.enrollment.intendedUserId,
                },
                payload: result.payload,
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
        // Admitting a phone and taking one away is something a directory has to be able
        // to do, and the person who does it is the one the directory file marks as an
        // administrator. There is no second kind of account and no admin UI: the CLI
        // drives these same routes, and the same identity rules apply to both.
        if (pathname.startsWith('/api/admin/')) {
            if (!operator && !user.admin) {
                return sendError(res, 403, 'NOT_ADMIN', 'Only an administrator may manage devices.');
            }
            /** Who did it, for the record and for the invitations: a person, or the console. */
            const actor = operator ? 'operator' : user.id;

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
                    // Whether this phone can be rung while it is asleep, which is a
                    // different fact from whether it can be sent anything at all.
                    hasVoipToken: Boolean(device.hasVoipToken),
                    createdAt: device.createdAt,
                    lastSeenAt: device.lastSeenAt,
                    revokedAt: device.revokedAt || null,
                };
            }

            // ── The directory ───────────────────────────────────────────────────
            //
            // Who is in this directory is written in a file, and the database's people are
            // derived from it on every start — so these edit the file and re-sync, rather
            // than writing rows that the next start would overwrite. What a directory may
            // be is checked before anything is written, and the file is replaced in one
            // move with the version before it kept beside.
            // Whether a login is how somebody is found here, which is also whether the
            // console asks for one when a person is added or changed. It is the same switch
            // that decides whether a proxy header is believed, because that header *is* the
            // login.
            //
            // A rule about editing, not about loading or listing: a directory already on
            // disk without a login is read and shown as it is, because refusing to read it
            // would be refusing to let anybody see, and so fix, what is missing.
            const requireLogins = config.trustTailscaleHeaders;

            const currentDirectory = () => directoryFile.read(config.directoryConfigPath);

            /** Writes the directory file, then makes the database agree with it. */
            function saveDirectory(next) {
                // Written without the login rule, which is reported instead — see
                // `directoryFile.missingLogins`, and the console, which shows it. A caller that
                // wants the strict reading can still ask for it; nothing that writes a directory
                // does, because a directory the server can run is not one it should refuse.
                directoryFile.write(config.directoryConfigPath, next, { requireLogins: false });
                store.syncDirectory(config.directoryConfigPath);
            }

            // Who is in the directory, as the file says — with what the database knows about
            // them. The two can disagree, by design, for somebody who has been taken out of
            // the file: their row stays so their history does, and this is where that is
            // visible rather than confusing.
            if (req.method === 'GET' && pathname === '/api/admin/people') {
                const rows = store.listUsers();
                const known = new Map(rows.map((user) => [user.id, user]));
                const directory = currentDirectory();
                // The people the file does not name.
                //
                // Private mode mints a user for any identity that reaches it
                // (`observeIdentity`, `src/api.js:175`), so those people are in the database
                // — with devices, sessions and calls pointing at them — while the file this
                // console edits has never heard of them. Measured 2026-09-26: a probe login
                // was `ts_72497f475e4f76d0b28f57c7 | Someone | someone@example.com` in the
                // database with `first_seen_at` set, and the file still listed three people.
                // Without this they are invisible here, and invisible is the one thing they
                // are not: their device keys work.
                //
                // A row that is not enabled is somebody taken out of the file on purpose —
                // removal keeps the row so the history does — and it is reported as such
                // rather than as an arrival, because the two need different answers.
                const listed = new Set(directory.users.map((user) => user.id.toLowerCase()));
                const unlisted = rows
                    .filter((user) => !listed.has(String(user.id).toLowerCase()))
                    .map((user) => ({
                        id: user.id,
                        displayName: user.displayName,
                        login: user.login || '',
                        firstSeen: user.firstSeen,
                        lastAuthenticated: user.lastAuthenticated,
                        // Active devices, the same count the People table shows, so the two
                        // read consistently; the Devices section is where a revocation is done.
                        devices: user.activeDevices,
                        takenOutOfTheFile: user.enabled === false,
                    }));
                return sendJson(res, 200, {
                    // Whether a login is how somebody is found here, so the console can ask
                    // for one where it is identity and leave the field optional where it is
                    // only a record of who somebody is elsewhere.
                    requireLogins,
                    // Who the login rule is about, for a console that no longer refuses the
                    // write over it: read on every load, so the answer is about the file as it
                    // is now rather than as it was when somebody last saved.
                    warnings: directoryFile.missingLogins(directory),
                    // Who can reach whom, as the file says. The app's entire list of people
                    // is this and nothing else, so a directory that has everybody in it and
                    // no pairs in it reads as an empty app — a state an operator has to be
                    // able to see rather than deduce.
                    contacts: directory.contacts || [],
                    unlisted,
                    people: directory.users.map((user) => ({
                        id: user.id,
                        displayName: user.displayName,
                        login: user.tailscaleLogin || '',
                        avatar: user.avatar || '',
                        admin: Boolean(user.admin),
                        suspended: user.enabled === false,
                        devices: known.get(user.id)?.activeDevices ?? 0,
                        lastAuthenticated: known.get(user.id)?.lastAuthenticated ?? null,
                        // Whether they have ever signed in. Until they have, nobody sees
                        // them whatever the contacts say — which is the difference between
                        // a directory that is wired up and one that only looks broken.
                        arrived: Boolean(known.get(user.id)?.firstSeen),
                    })),
                });
            }

            if (req.method === 'POST' && pathname === '/api/admin/people') {
                const body = await readJsonOrRefuse(req, res);
                if (!body) return;
                try {
                    saveDirectory(directoryFile.withPerson(currentDirectory(), body));
                } catch (error) {
                    return sendError(res, 400, 'DIRECTORY_INVALID', error.message);
                }
                log.info('directory_person_added', { personId: body.id, by: actor });
                return sendJson(res, 201, { users: store.listUsers() });
            }

            const personMatch = pathname.match(/^\/api\/admin\/people\/([A-Za-z0-9_-]{1,64})$/);
            if (req.method === 'POST' && personMatch) {
                const body = await readJsonOrRefuse(req, res);
                if (!body) return;
                try {
                    saveDirectory(directoryFile.withChanges(currentDirectory(), personMatch[1], body));
                } catch (error) {
                    return sendError(res, 400, 'DIRECTORY_INVALID', error.message);
                }
                log.info('directory_person_changed', { personId: personMatch[1], by: actor });
                return sendJson(res, 200, { users: store.listUsers() });
            }

            const removalMatch = pathname.match(/^\/api\/admin\/people\/([A-Za-z0-9_-]{1,64})\/remove$/);
            if (req.method === 'POST' && removalMatch) {
                const id = removalMatch[1];
                try {
                    saveDirectory(directoryFile.withoutPerson(currentDirectory(), id));
                } catch (error) {
                    return sendError(res, 400, 'DIRECTORY_INVALID', error.message);
                }
                // Their row stays, disabled. Calls, participants and devices all point at it,
                // and a directory's history is not something to erase to tidy a list.
                store.setUserEnabled(id, false);
                // Their devices go with them: a key left behind is a key that still opens the
                // door, and the person it belonged to is no longer in the directory.
                const now = new Date().toISOString();
                const devices = store.allDevices(id);
                for (const device of devices) store.revokeDevice(device.id, now);
                // The phones are no longer ringable here, and the relay is told so that they
                // are not ringable there either — which is also what frees their PushKit
                // tokens for another server to register. Each answer comes back with the
                // person: `revokedDevices` is this server's half, and a removal the relay has
                // not confirmed is named rather than left looking done.
                const relayOutcomes = await Promise.all(devices.map(async (device) => ({
                    deviceId: device.id,
                    ...await forgetAtRelay(device.id),
                })));
                log.info('directory_person_removed', { personId: id, devices: devices.length, by: actor });
                return sendJson(res, 200, {
                    users: store.listUsers(), revokedDevices: devices.length, relay: relayOutcomes,
                });
            }

            // ── Who can reach whom ──────────────────────────────────────────────
            //
            // The app's list of people is the contacts and nothing else, and a call is
            // refused unless every invitee is one — so this is what makes somebody
            // reachable, as opposed to merely present in the directory. Both directions are
            // written, because that is what reaching somebody is: the file can hold a
            // one-way pair and the server reads one, but a list where you appear to
            // somebody who does not appear to you is not a control anybody asked for.
            /** The two ids a contact change names, or null after answering with a refusal. */
            async function contactPair(req, res) {
                const body = await readJsonOrRefuse(req, res);
                if (!body) return null;
                return { ownerId: String(body.ownerId || ''), contactId: String(body.contactId || '') };
            }

            if (req.method === 'POST' && pathname === '/api/admin/contacts') {
                const pair = await contactPair(req, res);
                if (!pair) return;
                try {
                    saveDirectory(directoryFile.withContact(currentDirectory(), pair.ownerId, pair.contactId));
                } catch (error) {
                    return sendError(res, 400, 'DIRECTORY_INVALID', error.message);
                }
                log.info('directory_contact_added', { ...pair, by: actor });
                return sendJson(res, 200, { contacts: currentDirectory().contacts || [] });
            }

            if (req.method === 'POST' && pathname === '/api/admin/contacts/remove') {
                const pair = await contactPair(req, res);
                if (!pair) return;
                try {
                    saveDirectory(directoryFile.withoutContact(currentDirectory(), pair.ownerId, pair.contactId));
                } catch (error) {
                    return sendError(res, 400, 'DIRECTORY_INVALID', error.message);
                }
                log.info('directory_contact_removed', { ...pair, by: actor });
                return sendJson(res, 200, { contacts: currentDirectory().contacts || [] });
            }

            if (req.method === 'POST' && pathname === '/api/admin/contacts/everyone') {
                try {
                    saveDirectory(directoryFile.withEveryoneConnected(currentDirectory()));
                } catch (error) {
                    return sendError(res, 400, 'DIRECTORY_INVALID', error.message);
                }
                log.info('directory_contacts_opened', { people: currentDirectory().users.length, by: actor });
                return sendJson(res, 200, { contacts: currentDirectory().contacts || [] });
            }

            // ── Settings, and the mode ──────────────────────────────────────────
            //
            // The settings an operator may change, and nothing else: these are the ones
            // whose worst case is a server that behaves differently, rather than one nobody
            // can reach. Every change is checked before it is written, the file is then
            // checked as a process starting from it would read it, and it is put back if
            // that fails — a setting that stops the server starting is worse than any
            // setting is good. A change that holds is followed by a restart, because the
            // configuration is read once and that is the only moment it is consistent.
            //
            // The change and the putting-back both go through `writeEnvFile`, which writes
            // `.env` in place: this is the console, so it runs inside the service's sandbox,
            // where the file may be written and its directory may not — see the comment on
            // the writer. What that costs is atomicity; what stands behind it is
            // `<DATA_DIR>/env.previous`, written first, and `doctor`, which reports a file
            // that no longer says which mode it is in.
            const envPath = config.envFile;
            const envContent = () => fs.readFileSync(envPath, 'utf8');

            /** Rewrites `.env` and verifies the result, undoing it if the result is broken. */
            function writeEnv(change, event, detail) {
                const before = envContent();
                let after;
                try {
                    after = change(before);
                } catch (error) {
                    return { ok: false, changed: false, message: error.message };
                }
                if (after === before) return { ok: true, changed: false };

                writeEnvFile(envPath, after);
                // Verified in the directory of the file just written, not of the process: on a
                // deployment they are the same, and anywhere else the answer must still be
                // about this file rather than whatever the working directory happens to hold.
                const check = verifyEnvFile(path.dirname(envPath));
                if (!check.ok) {
                    writeEnvFile(envPath, before);
                    return { ok: false, changed: false, message: check.message };
                }
                log.info(event, detail);
                return { ok: true, changed: true };
            }

            /** Answers first, then leaves: the restart must not beat the response out. */
            function restarting(res, changed) {
                if (changed) setTimeout(() => process.exit(0), 400);
                return sendJson(res, 200, { ok: true, changed, restarting: changed });
            }

            /** What a setting is now, as this process is using it. */
            function currentValue(key) {
                switch (key) {
                    case 'MAX_PARTICIPANTS': return config.maxParticipants;
                    case 'CALL_RING_SECONDS': return config.callRingSeconds;
                    case 'ALLOW_SELF_CALLS': return config.allowSelfCalls;
                    case 'AUTO_ENROL_IDENTITIES': return config.autoEnrolIdentities;
                    case 'CROSSBAR_ENROLLMENT_TTL_SECONDS': return config.enrollmentTtlSeconds;
                    case 'CROSSBAR_SESSION_TTL_SECONDS': return config.sessionTtlSeconds;
                    case 'CROSSBAR_CHALLENGE_TTL_SECONDS': return config.challengeTtlSeconds;
                    case 'ICE_STUN_URL': return config.iceServers?.[0]?.urls || '';
                    case 'CROSSBAR_TURN_HOST': return config.turn.host;
                    case 'CROSSBAR_TURN_PORT': return config.turn.port;
                    case 'CROSSBAR_TURN_MIN_PORT': return config.turn.minPort;
                    case 'CROSSBAR_TURN_MAX_PORT': return config.turn.maxPort;
                    case 'CROSSBAR_TURN_TTL_SECONDS': return config.turn.ttlSeconds;
                    case 'MAX_MESSAGE_BYTES': return config.messageBytes;
                    case 'PING_INTERVAL_MS': return config.pingIntervalMs;
                    case 'PING_TIMEOUT_MS': return config.pingTimeoutMs;
                    case 'RELAY_PER_SECOND': return config.relayPerSecond;
                    case 'MALFORMED_LIMIT': return config.malformedLimit;
                    default: return '';
                }
            }

            if (req.method === 'GET' && pathname === '/api/admin/settings') {
                const content = envContent();
                return sendJson(res, 200, {
                    mode: config.networkMode,
                    modes: MODES.map((mode) => {
                        const block = modeBlock(content, mode);
                        // The question the mode units' `ExecCondition` asks, so what the console
                        // shows and what the shapers act on cannot drift apart.
                        const { configured, missing } = modeConfigured(mode, envPath);
                        return {
                            mode,
                            hostname: block.HOSTNAME,
                            origin: block.ORIGIN,
                            inForce: mode === config.networkMode,
                            configured,
                            missing,
                        };
                    }),
                    knobs: KNOBS.map((knob) => ({ ...knob, value: currentValue(knob.key) })),
                });
            }

            if (req.method === 'POST' && pathname === '/api/admin/settings') {
                const body = await readJsonOrRefuse(req, res);
                if (!body) return;
                const outcome = writeEnv((content) => applyKnobs(content, body.changes),
                    'settings_changed', { changed: Object.keys(body.changes || {}), by: actor });
                if (!outcome.ok) return sendError(res, 400, 'SETTINGS_REFUSED', outcome.message);
                return restarting(res, outcome.changed);
            }

            if (req.method === 'POST' && pathname === '/api/admin/mode') {
                const body = await readJsonOrRefuse(req, res);
                if (!body) return;
                const wanted = String(body.mode || '');
                if (!MODES.includes(wanted)) {
                    return sendError(res, 400, 'MODE_REFUSED', `The mode has to be one of ${MODES.join(', ')}.`);
                }
                const outcome = writeEnv((content) => {
                    // Refused before anything is written, and it is the same question the mode units
                    // ask before they move a door (`modeConfigured`) — the answer this route's own
                    // card shows. Verification below cannot stand in for it: a private block with no
                    // origin loads on the loopback default, so the rewrite would pass and leave a box
                    // saying `private` whose front door never opens.
                    const { configured, missing } = modeConfigured(wanted, envPath);
                    if (!configured) {
                        throw new Error(`Cannot switch to ${wanted}: ${missing.join(', ')}`
                            + ` ${missing.length === 1 ? 'is' : 'are'} not set in its block.`);
                    }
                    return applyMode(content, wanted);
                }, 'mode_changed', { mode: wanted, by: actor });
                if (!outcome.ok) return sendError(res, 400, 'MODE_REFUSED', outcome.message);
                return restarting(res, outcome.changed);
            }

            // ── What has happened, and what this machine is doing ───────────────
            if (req.method === 'GET' && pathname === '/api/admin/usage') {
                const since = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
                // Every day, including the quiet ones: a chart that only drew the days with
                // calls in them would put a fortnight in the space of an afternoon.
                const recorded = new Map(store.usageByDay(since).map((row) => [row.day, row]));
                const days = [];
                for (let back = 13; back >= 0; back -= 1) {
                    const day = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
                    days.push(recorded.get(day) || { day, calls: 0, answered: 0, minutes: 0 });
                }
                return sendJson(res, 200, {
                    days,
                    pairs: store.callPairs(since),
                    invitations: store.invitationTally(),
                    platforms: store.devicePlatforms(),
                });
            }

            if (req.method === 'GET' && pathname === '/api/admin/host') {
                const load = os.loadavg();
                const memory = { total: os.totalmem(), free: os.freemem() };
                let disk = null;
                try {
                    const stats = fs.statfsSync(config.dataDir);
                    disk = { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize };
                } catch {
                    // A filesystem that will not answer is not a reason to refuse the rest.
                }
                let database = 0;
                try {
                    database = fs.statSync(path.join(config.dataDir, 'crossbar.sqlite')).size;
                } catch {
                    database = 0;
                }
                return sendJson(res, 200, {
                    load: { one: load[0], five: load[1], fifteen: load[2], cpus: os.cpus().length || 1 },
                    memory: { ...memory, process: process.memoryUsage().rss },
                    disk,
                    database,
                    uptime: { host: os.uptime(), process: process.uptime() },
                });
            }

            if (req.method === 'GET' && pathname === '/api/admin/status') {
                const now = new Date().toISOString();
                return sendJson(res, 200, {
                    // The build that answered, which is the first question about a deployment
                    // that nobody can answer from anywhere else: the checkout on the box, the
                    // CLI and the file it reads can all be something other than the process.
                    // Same answer `/api/health` gives, and the same reason for it.
                    version: require('../package.json').version,
                    mode: config.networkMode,
                    hostname: config.publicHostname || null,
                    origin: config.publicOrigin,
                    requireDeviceAuth: config.requireDeviceAuth,
                    deviceAuthEnabled: Boolean(config.sessionSecret),
                    // Two transports, for two different things. A missed call is an ordinary
                    // notification and goes to Apple from this deployment, so `apns` is
                    // about being *told* something. A ringing call is a VoIP push and goes
                    // through the relay below, which is what wakes a suspended app — so
                    // `relay` is the one that decides whether a locked phone rings. Without
                    // either, the fault reads as the app's rather than the deployment's.
                    apns: { enabled: Boolean(apns?.enabled), topic: apns?.topic || '' },
                    relay: {
                        enabled: Boolean(relay?.enabled),
                        installationId: relay?.installationId || null,
                        timeoutMs: relay?.timeoutMs || null,
                    },
                    turn: config.turn?.host
                        ? {
                            host: config.turn.host,
                            port: config.turn.port,
                            relayPorts: [config.turn.minPort, config.turn.maxPort],
                            ttlSeconds: config.turn.ttlSeconds,
                        }
                        : null,
                    // The directory's people, not the rows: somebody taken out of the file
                    // keeps their row for the history's sake, and counting rows here would
                    // make this card disagree with the People table beneath it.
                    users: directoryFile.read(config.directoryConfigPath).users.length,
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
                    createdBy: actor,
                    ttlSeconds: Number(body.ttlSeconds) || null,
                });
                if (!result.ok) return authFailure(res, result.reason);
                log.info('enrollment_created', {
                    enrollmentId: result.enrollment.id,
                    intendedUserId: result.enrollment.intendedUserId,
                    createdBy: actor,
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

            const deviceMatch = pathname.match(/^\/api\/admin\/devices\/([A-Za-z0-9_-]{8,64})\/(revoke|rename|remove)$/);
            if (req.method === 'POST' && deviceMatch) {
                const target = store.deviceIdentity(deviceMatch[1]);
                if (!target) return sendError(res, 404, 'DEVICE_UNKNOWN', 'That device is not enrolled with this server.');
                const now = new Date().toISOString();

                // The one action here that cannot be undone, and the reason it is offered
                // only for a device that has already been taken out of use: revoking stops a
                // key working and keeps the record, and this is the record going too. A
                // single click that did both would make the accident unrecoverable.
                if (deviceMatch[2] === 'remove') {
                    if (target.status === 'active') {
                        return sendError(res, 409, 'DEVICE_STILL_ACTIVE',
                            'That device still works. Take its key out of use first, then remove it.');
                    }
                    store.removeDevice(target.id);
                    log.info('device_removed', { deviceId: target.id, userId: target.userId, by: actor });
                    // A phone that still works is not removable, so a row that reached here was
                    // revoked first — and that revocation already told the relay. This second
                    // removal is the belt to its braces, and answers `404` when there is nothing
                    // left to forget. The relay's answer comes back with it: `removed` is this
                    // server's record going, and the removal at the relay is the other half.
                    const reported = await forgetAtRelay(target.id);
                    return sendJson(res, 200, { removed: true, relay: reported });
                }

                if (deviceMatch[2] === 'revoke') {
                    store.revokeDevice(target.id, now);
                    log.info('device_revoked', { deviceId: target.id, userId: target.userId, by: actor });
                    // The token is kept locally on purpose — a rotated PushKit token is the only
                    // way to reach that phone until it reports another — but the relay is told to
                    // forget the device, because a token still owned by this installation is what
                    // stops the phone being rung by whichever server it moves to. A relay that
                    // refused is reported as such rather than hidden behind the local revocation.
                    const reported = await forgetAtRelay(target.id);
                    return sendJson(res, 200, { device: adminDevice(store.deviceIdentity(target.id)), relay: reported });
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
                log.info('enrollment_revoked', { enrollmentId: enrollmentMatch[1], by: actor });
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
                // An id somebody else already holds is not a malformed request: it is a fact
                // about that id, and the same request with the same id will keep failing, so it
                // is said plainly rather than dressed as a client error (SEC-RELAY-01).
                if (error.code === 'DEVICE_OWNED') {
                    log.warn('device_ownership_refused', { userId: user.id, deviceId: error.deviceId });
                    return sendError(res, 409, 'DEVICE_OWNED', 'That device id is already registered to somebody else.');
                }
                return sendError(res, 400, 'INVALID_DEVICE', error.message);
            }
        }

        // A device releasing itself.
        //
        // The operator route can only be reached with a console session, and a phone on its way
        // out of a deployment deletes its key before anybody with a console could act — so this
        // is the last moment the relay can be told not to ring it, and it is the call the app
        // makes on unpair (SEC-RELAY-04). It is *not* the operator route: the target must be the
        // device this session proved itself to be, so an enrolled device cannot unring somebody
        // else's phone, or even a second phone of its own person's, by naming it.
        //
        // Revoked rather than erased, which is the same end state the operator's `revoke` leaves:
        // the key stops working, the tokens are dropped here, and the row stays as the record of
        // a device that existed. Erasing it would free the id for whoever claims it next, which
        // is the opposite of what a device signing off should do.
        const releaseMatch = pathname.match(/^\/api\/devices\/([A-Za-z0-9_-]{8,64})$/);
        if (req.method === 'DELETE' && releaseMatch) {
            const id = releaseMatch[1];
            if (!lifecycle.limiter.take(`${user.id}:device-release`, 10, 60000)) {
                return sendError(res, 429, 'RATE_LIMITED', 'Please wait and try again.');
            }
            // The device the session belongs to, not one the request names.
            const { device: self } = currentUser(req);
            if (!self || self.id !== id) {
                return sendError(res, 403, 'DEVICE_NOT_YOURS', 'A device may only remove itself.');
            }
            const now = new Date().toISOString();
            store.revokeDevice(id, now);
            log.info('device_released_by_itself', { deviceId: id, userId: user.id });
            // The relay's own answer is reported, not assumed: this is the one chance the app has
            // to know whether its PushKit token is still claimed by this deployment.
            const reported = await forgetAtRelay(id);
            return sendJson(res, 200, { removed: true, relay: reported });
        }

        if (req.method === 'POST' && pathname === '/api/devices/push-token') {
            // Limited like its sibling `/api/push/subscriptions`, and for the same reason: this
            // route reaches the relay, and a token upload happens on every launch and every
            // rotation, so an unauthenticated-in-effect loop here is this server hammering the
            // relay with the installation's credential (REL-RELAY-01).
            if (!lifecycle.limiter.take(`${user.id}:push-token`, 10, 60000)) {
                return sendError(res, 429, 'RATE_LIMITED', 'Please wait and try again.');
            }
            const body = await readJson(req);
            const id = String(body.deviceId || '');
            const device = store.deviceIdentity(id);
            if (!device || device.userId !== user.id) {
                return sendError(res, 404, 'DEVICE_NOT_FOUND', 'That device is not registered to you.');
            }
            // A revoked device is not a device any more: its key does not work and its row is
            // kept only as a record. Registering its token would make the relay ring a phone this
            // deployment has taken out of use — and the relay's upsert sets the device active
            // again, so the upload would undo the operator's revocation (SEC-RELAY-02).
            if (device.status !== 'active') {
                return sendError(res, 409, 'DEVICE_REVOKED',
                    `That device is ${device.status}, not active; enrol it again before registering a token.`);
            }
            // Two kinds, because a phone holds two tokens: the alert token a notification
            // goes to, and the VoIP token a ringing call goes to. Omitted means the alert
            // one, which is what a client written before this existed sends.
            const kind = body.kind === 'voip' ? 'voip' : 'alert';
            const token = String(body.token || '');
            store.savePushToken({
                deviceId: id,
                token,
                // A token is only valid at the host that issued it, so this selects where a
                // push is sent and is not free text. Anything else would be a token that
                // silently never arrives.
                environment: body.environment === 'sandbox' ? 'sandbox' : 'production',
                kind,
                now: new Date().toISOString(),
            });
            // A rotated token is an update at the same device id rather than a new device,
            // which is what makes this an upsert on both sides. The alert token is not
            // registered: the relay rings phones and sends nothing else — the missed-call
            // notification stays on this deployment's own APNs key.
            //
            // `saved` stays true because the row *was* written; `relay` is the separate answer
            // of whether a call can reach the phone, and a relay that refused leaves it saying
            // so. The app keeps the token pending while that answer is `retryable`, which is
            // what stops a registration made during a relay timeout from leaving the phone
            // permanently unringable.
            if (kind === 'voip') {
                return sendJson(res, 200, { saved: true, relay: await registerAtRelay(id, token) });
            }
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

        // What has happened, as opposed to what is happening: the same records the route
        // below reads, without the filter that makes it a list of calls to rejoin.
        if (req.method === 'GET' && pathname === '/api/calls/history') {
            return sendJson(res, 200, { calls: store.callHistory(user.id) });
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
            case 'INVALID_INVITEES': return 'Choose one or more contacts.';
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
