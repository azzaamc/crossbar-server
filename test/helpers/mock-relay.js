'use strict';

// A stand-in for the Crossbar Push Relay, faithful to the routes and the refusals it
// documents.
//
// The relay cannot be reached from a test — it is a Cloudflare Worker holding the only
// Apple signing key — so the only way to pin what the backend must send it, and what it
// must tolerate coming back, is to reproduce its side of the wire here. Every decision
// below was read from the relay's source rather than invented: the route order is
// `src/app.ts`'s, the status map and error bodies are `src/http.ts`'s, the field rules are
// `src/validation/index.ts`'s, the document is `src/apns/payload.ts`'s, and the
// duplicate-suppression state machine is `src/db/idempotency.ts`'s.
//
// It records what it received, so a test asserts on what the relay would have seen rather
// than on what the caller believes it sent. That is the whole point: a backend that builds a
// plausible-looking request Apple would refuse fails here instead of on a phone that never
// rings.
//
// It is deliberately not a general HTTP mock: it knows four routes and refuses everything
// else, exactly as the relay does.

const http = require('node:http');
const crypto = require('node:crypto');

const SERVICE = 'crossbar-push-relay';

/** The largest request body the relay accepts anywhere. */
const MAX_BODY_BYTES = 4096;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const PUSH_TOKEN_PATTERN = /^[0-9a-fA-F]{32,512}$/;
const CREDENTIAL_PATTERN = /^cbr_[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREDENTIAL_IN_TEXT = /cbr_[A-Za-z0-9_-]{43}/;
const DEVICE_PATH = /^\/v1\/devices\/([^/]+)$/;

const INCOMING_CALL_FIELDS = ['request_id', 'device_id', 'call_id', 'caller_id', 'caller_name', 'has_video'];
const REGISTER_DEVICE_FIELDS = ['voip_token'];
const FORBIDDEN_FIELDS = ['__proto__', 'constructor', 'prototype'];

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const MAX_CALLER_TEXT = 64;

/** How long the relay tells a caller to wait after an APNs fault. */
const APNS_RETRY_AFTER_SECONDS = 2;
/** How long it tells a caller to wait when the deployment cannot sign at all. */
const MISCONFIGURED_RETRY_AFTER_SECONDS = 300;
/** How long an `in_flight` claim is believed before another attempt may take it over. */
const IN_FLIGHT_LEASE_SECONDS = 30;

const STATUS = Object.freeze({
    unauthorized: 401,
    not_found: 404,
    token_conflict: 409,
    idempotency_conflict: 409,
    request_in_progress: 409,
    suspended: 403,
    forbidden: 403,
    bad_request: 400,
    method_not_allowed: 405,
    unsupported_media_type: 415,
    payload_too_large: 413,
    rate_limited: 429,
    device_unregistered: 410,
    apns_rejected: 502,
    apns_unavailable: 503,
    internal: 500,
});

const BASE_HEADERS = Object.freeze({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
});

/**
 * The five things APNs can say, reduced to what the relay acts on.
 *
 * Only the three the brief names are interesting to a caller: a permanent device failure
 * (`device_invalid`), something Apple could not take now (`transient`), and the relay's own
 * allowance (`rate_limited`, which is the limiter rather than APNs). The other two exist so
 * that "accepted" and "the relay sent something Apple refuses" are not both spelled
 * "something failed".
 */
const PUSH_OUTCOMES = Object.freeze({
    /** APNs took it. A 200 does not mean the phone rang. */
    accepted: 'accepted',
    /** The token is gone. The relay marks the device inactive and answers 410. */
    device_invalid: 'device_invalid',
    /** APNs could not take it now. The relay answers 503 and stays retryable. */
    transient: 'transient',
    /** The relay's own request was wrong — topic, push type, payload. Answers 502. */
    request_rejected: 'request_rejected',
});

/** The APNs `:status` each outcome stands for, recorded as the relay would record it. */
const APNS_STATUS = Object.freeze({
    accepted: 200,
    device_invalid: 410,
    transient: 503,
    request_rejected: 400,
});

function base64url(bytes) {
    return Buffer.from(bytes).toString('base64url');
}

function generateCredential() {
    return `cbr_${base64url(crypto.randomBytes(32))}`;
}

function generateInstallationId() {
    return `ins_${base64url(crypto.randomBytes(16))}`;
}

/** The relay's failure body, as text: a code, and a reason only when one is on the allowlist. */
function errorBody(code, reason) {
    return JSON.stringify(reason === undefined ? { error: code } : { error: code, reason });
}

function headers(extra = {}) {
    return { ...BASE_HEADERS, ...extra };
}

function bodyOf(text, extra = {}) {
    return { status: 200, headers: headers(extra), body: text };
}

function failure(code, { reason, retryAfterSeconds, allow } = {}) {
    const extra = {};
    if (code === 'unauthorized') extra['www-authenticate'] = 'Bearer realm="crossbar-push-relay"';
    if (retryAfterSeconds !== undefined) extra['retry-after'] = String(Math.max(1, Math.ceil(retryAfterSeconds)));
    if (allow) extra.allow = allow;
    return { status: STATUS[code], headers: headers(extra), body: errorBody(code, reason) };
}

/**
 * The body the relay sends to APNs, exactly as `src/apns/payload.ts` builds it.
 *
 * Key order is fixed there so that the body is readable in a log, and it is fixed here for
 * the same reason and one more: a test asserting the field *order* is asserting that the
 * namespaced object is the one the app's decoder walks, not a hash-map coincidence.
 */
function voipPayload(call, installationId) {
    return JSON.stringify({
        aps: { 'content-available': 1 },
        crossbar: {
            v: 1,
            type: 'incoming_call',
            installation_id: installationId,
            call_id: call.callId,
            caller_id: call.callerId,
            caller_name: call.callerName,
            has_video: call.hasVideo,
        },
    });
}

/**
 * A digest of what the request means, which is what duplicate suppression is keyed on.
 *
 * Taken over the validated fields rather than over the raw bytes, so a caller retrying with
 * the same values in a different key order — or with insignificant whitespace — is the same
 * request. `request_id` is excluded because it is the key itself.
 */
function callDigest(call) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify([call.deviceId, call.callId, call.callerId, call.callerName, call.hasVideo]))
        .digest('hex');
}

function isCredential(value) {
    return CREDENTIAL_PATTERN.test(value);
}

/** The credential a request presents, or null. Mirrors `parseBearer` in the relay. */
function parseBearer(request) {
    if (CREDENTIAL_IN_TEXT.test(request.url)) return null;
    const cookie = request.headers.get('cookie');
    if (cookie !== null && CREDENTIAL_IN_TEXT.test(cookie)) return null;

    const header = request.headers.get('authorization');
    if (header === null) return null;
    const parts = header.split(' ');
    if (parts.length !== 2) return null;
    if ((parts[0] ?? '').toLowerCase() !== 'bearer') return null;
    const credential = parts[1] ?? '';
    if (credential.includes(',')) return null;
    return isCredential(credential) ? credential : null;
}

function hasExpectedFields(body, allowed) {
    for (const field of Object.keys(body)) {
        if (FORBIDDEN_FIELDS.includes(field) || !allowed.includes(field)) return false;
    }
    return true;
}

/** `src/validation/index.ts`: one answer for every malformed request, never a per-field one. */
function validateIncomingCall(body) {
    if (!hasExpectedFields(body, INCOMING_CALL_FIELDS)) return null;

    const requestId = body.request_id;
    if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId.toLowerCase())) return null;

    const deviceId = body.device_id;
    if (typeof deviceId !== 'string' || isCredential(deviceId)) return null;
    if (!DEVICE_ID_PATTERN.test(deviceId)) return null;

    const callId = body.call_id;
    if (typeof callId !== 'string' || !UUID_PATTERN.test(callId.toLowerCase())) return null;

    const callerId = body.caller_id;
    if (typeof callerId !== 'string') return null;
    if (callerId.length > MAX_CALLER_TEXT || CONTROL_CHARACTERS.test(callerId)) return null;

    const callerName = body.caller_name;
    if (typeof callerName !== 'string') return null;
    if (callerName.length > MAX_CALLER_TEXT || CONTROL_CHARACTERS.test(callerName)) return null;

    // Strictly a boolean: `"true"` would make `has_video` mean two different things.
    if (typeof body.has_video !== 'boolean') return null;

    return {
        requestId: requestId.toLowerCase(),
        deviceId,
        callId: callId.toLowerCase(),
        callerId,
        callerName,
        hasVideo: body.has_video,
    };
}

function validateRegisterDevice(body) {
    if (!hasExpectedFields(body, REGISTER_DEVICE_FIELDS)) return null;
    const token = body.voip_token;
    if (typeof token !== 'string' || !PUSH_TOKEN_PATTERN.test(token)) return null;
    return { token: token.toLowerCase() };
}

function validateDeviceId(raw) {
    if (isCredential(raw) || !DEVICE_ID_PATTERN.test(raw)) return null;
    return { deviceId: raw };
}

/**
 * Create a mock relay.
 *
 * The returned object is both the handler and the ledger. `handle(request)` takes a `fetch`
 * `Request` and returns a `Response`, so the whole contract can be exercised in-process with
 * no socket at all; `listen(port)` puts the same handler behind a real HTTP server for the
 * cases that need a URL, which is also how the backend's own client reaches it.
 */
function createMockRelay(options = {}) {
    const version = options.version ?? 'test';
    const environment = options.environment ?? 'development';
    const credential = options.credential ?? generateCredential();
    const installationId = options.installationId ?? generateInstallationId();
    const idempotencyTtlSeconds = options.idempotencyTtlSeconds ?? 24 * 60 * 60;

    const installations = new Map([[credential, { id: installationId, status: 'active' }]]);
    for (const extra of options.credentials ?? []) {
        installations.set(extra.credential, { id: extra.installationId, status: 'active' });
    }

    /** device key -> row. `installation_id` is in the key, which is the whole of tenant isolation. */
    const devices = new Map();
    /** token -> device key, which is the `UNIQUE(token)` constraint expressed as an index. */
    const tokens = new Map();
    /** `(installation_id, request_id)` -> duplicate-suppression record. */
    const idempotency = new Map();

    /** Everything the relay received, refusals included, in order. */
    const requests = [];
    /** Every attempt that reached APNs, with the payload it carried. */
    const pushes = [];

    /** Outcomes to answer the next pushes with. Empty means `accepted`. */
    const outcomes = [];
    /** A decision to force on the next limiter consultation, or null to allow. */
    const limits = { push: null, device: null };
    let apnsConfigured = options.apnsConfigured ?? true;
    let clock = Date.now();

    const deviceKey = (installation, device) => `${installation}\u0000${device}`;

    function now() {
        return clock;
    }

    /** Advance the mock's clock, for the idempotency window and lease tests. */
    function advance(ms) {
        clock += ms;
    }

    function readJsonObject(record) {
        const contentType = (record.headers['content-type'] ?? '').trim().toLowerCase();
        if (contentType !== 'application/json') return { ok: false, response: failure('unsupported_media_type') };

        const declared = Number(record.headers['content-length'] ?? '0');
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
            return { ok: false, response: failure('payload_too_large') };
        }
        if (record.bytes > MAX_BODY_BYTES) return { ok: false, response: failure('payload_too_large') };
        if (record.text === '') return { ok: false, response: failure('bad_request') };

        let parsed;
        try {
            parsed = JSON.parse(record.text);
        } catch {
            return { ok: false, response: failure('bad_request') };
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { ok: false, response: failure('bad_request') };
        }
        return { ok: true, value: parsed };
    }

    function authenticate(record, url) {
        const presented = parseBearer({ url, headers: new Headers(record.headers) });
        if (presented === null) return { ok: false, response: failure('unauthorized') };
        const installation = installations.get(presented);
        if (installation === undefined) return { ok: false, response: failure('unauthorized') };
        if (installation.status !== 'active') return { ok: false, response: failure('suspended') };
        return { ok: true, installation };
    }

    function limitDecision(budget) {
        const forced = limits[budget];
        if (forced === null || forced === undefined) return { allowed: true, retryAfterSeconds: 0, limit: null };
        return typeof forced === 'function' ? forced() : forced;
    }

    /** Claim the key, or explain why it cannot be claimed. `src/db/idempotency.ts`'s state machine. */
    function begin(installation, requestId, bodyHash) {
        const key = `${installation}\u0000${requestId}`;
        const held = idempotency.get(key);
        const at = now();

        if (held !== undefined) {
            const expired = at - held.updatedAt > idempotencyTtlSeconds * 1000;
            const sameBody = held.bodyHash === bodyHash;
            const leaseExpired = at - held.updatedAt > IN_FLIGHT_LEASE_SECONDS * 1000;
            const reclaimable = expired
                || (held.state === 'failed' && sameBody)
                || (held.state === 'in_flight' && sameBody && leaseExpired);
            if (!reclaimable) {
                if (!sameBody) return { kind: 'conflict' };
                if (held.state === 'in_flight') {
                    const seconds = Math.max(1, Math.ceil((held.updatedAt + IN_FLIGHT_LEASE_SECONDS * 1000 - at) / 1000));
                    return { kind: 'busy', retryAfterSeconds: seconds };
                }
                if (held.state === 'failed') return { kind: 'busy', retryAfterSeconds: 1 };
                return { kind: 'replay', record: held };
            }
        }

        const claim = crypto.randomUUID();
        idempotency.set(key, {
            bodyHash,
            claim,
            state: 'in_flight',
            status: null,
            body: null,
            apnsId: null,
            createdAt: at,
            updatedAt: at,
        });
        return { kind: 'started', claim, key };
    }

    function finish(key, claim, state, status, body, apnsId) {
        const held = idempotency.get(key);
        // Only the attempt holding the row's claim may write, which is what stops a lagging
        // attempt replacing a real answer with a stale one.
        if (held === undefined || held.claim !== claim || held.state !== 'in_flight') return;
        held.state = state;
        held.status = status;
        held.body = body;
        held.apnsId = apnsId;
        held.updatedAt = now();
    }

    function replay(record) {
        return {
            status: record.status ?? STATUS.internal,
            headers: headers(),
            body: record.body ?? errorBody('internal'),
        };
    }

    function nextOutcome() {
        const entry = outcomes.shift();
        if (entry === undefined) return { kind: PUSH_OUTCOMES.accepted, reason: null };
        if (typeof entry === 'string') return { kind: entry, reason: null };
        return entry;
    }

    function registerDevice(installation, rawDeviceId, record) {
        const deviceId = validateDeviceId(rawDeviceId);
        if (deviceId === null) return failure('bad_request');

        const body = readJsonObject(record);
        if (!body.ok) return body.response;
        const registration = validateRegisterDevice(body.value);
        if (registration === null) return failure('bad_request');

        const decision = limitDecision('device');
        if (!decision.allowed) return failure('rate_limited', { retryAfterSeconds: decision.retryAfterSeconds });

        const at = now();
        const key = deviceKey(installation.id, deviceId.deviceId);
        const holder = tokens.get(registration.token);
        // The token clause is judged first, because it is the one that decides ownership: a
        // token already owned keeps its owner, whatever device id the caller wrapped around it.
        if (holder !== undefined && holder !== key) return failure('token_conflict');

        const held = devices.get(key);
        // A rotation replaces the token this device held, so the old token stops having an
        // owner — the index is over tokens, and a token no device holds is nobody's.
        if (held !== undefined && held.token !== registration.token) tokens.delete(held.token);
        devices.set(key, {
            installationId: installation.id,
            deviceId: deviceId.deviceId,
            token: registration.token,
            active: true,
            createdAt: held?.createdAt ?? at,
            lastSeenAt: at,
            lastPushAt: held?.lastPushAt ?? null,
            lastApnsStatus: held?.lastApnsStatus ?? null,
            lastApnsReason: held?.lastApnsReason ?? null,
        });
        tokens.set(registration.token, key);

        return bodyOf(JSON.stringify({ ok: true, device_id: deviceId.deviceId, registered: true }));
    }

    function removeDevice(installation, rawDeviceId) {
        const deviceId = validateDeviceId(rawDeviceId);
        if (deviceId === null) return failure('bad_request');

        const decision = limitDecision('device');
        if (!decision.allowed) return failure('rate_limited', { retryAfterSeconds: decision.retryAfterSeconds });

        const key = deviceKey(installation.id, deviceId.deviceId);
        const held = devices.get(key);
        if (held === undefined) return failure('not_found');
        devices.delete(key);
        tokens.delete(held.token);
        return bodyOf(JSON.stringify({ ok: true, device_id: deviceId.deviceId, removed: true }));
    }

    function pushVoip(installation, record) {
        const body = readJsonObject(record);
        if (!body.ok) return body.response;
        const call = validateIncomingCall(body.value);
        if (call === null) return failure('bad_request');

        if (!apnsConfigured) {
            // Everything but delivery works without a key, so this is a deployment that is not
            // finished rather than a request that was wrong — and the retry hint is long,
            // because nothing a caller does fixes a missing key.
            return failure('apns_unavailable', { retryAfterSeconds: MISCONFIGURED_RETRY_AFTER_SECONDS });
        }

        const key = deviceKey(installation.id, call.deviceId);
        const device = devices.get(key);
        // Absent, somebody else's, and inactive are one answer.
        if (device === undefined || !device.active) return failure('not_found');

        const begun = begin(installation.id, call.requestId, callDigest(call));
        if (begun.kind === 'replay') return replay(begun.record);
        if (begun.kind === 'conflict') return failure('idempotency_conflict');
        if (begun.kind === 'busy') {
            return failure('request_in_progress', { retryAfterSeconds: begun.retryAfterSeconds });
        }

        // After the claim, so the allowance is spent on pushes that are actually attempted —
        // and so a replay of an accepted push is answered from its record even when the
        // allowance is spent. The claim is released, because nothing was sent and holding the
        // key would answer the caller's next attempt about a push that never happened.
        const decision = limitDecision('push');
        if (!decision.allowed) {
            finish(begun.key, begun.claim, 'failed', null, null, null);
            return failure('rate_limited', { retryAfterSeconds: decision.retryAfterSeconds });
        }

        const outcome = nextOutcome();
        const payloadText = voipPayload(call, installation.id);
        const at = now();

        pushes.push({
            ...call,
            installationId: installation.id,
            apnsToken: device.token,
            outcome: outcome.kind,
            apnsStatus: APNS_STATUS[outcome.kind],
            payloadText,
            payload: JSON.parse(payloadText),
            at,
        });

        device.lastPushAt = at;
        device.lastApnsStatus = APNS_STATUS[outcome.kind] ?? null;
        device.lastApnsReason = outcome.reason ?? null;

        if (outcome.kind === PUSH_OUTCOMES.device_invalid) {
            // APNs has said this token is gone, so the device stops being pushed to and every
            // later push for it answers 404 until it registers again.
            device.active = false;
            finish(begun.key, begun.claim, 'rejected', STATUS.device_unregistered, errorBody('device_unregistered'), null);
            return failure('device_unregistered');
        }

        if (outcome.kind === PUSH_OUTCOMES.transient) {
            // Recorded as failed rather than terminal, so the retry genuinely sends rather than
            // being answered "already done" about a ring nobody heard.
            finish(begun.key, begun.claim, 'failed', STATUS.apns_unavailable, errorBody('apns_unavailable'), null);
            return failure('apns_unavailable', { retryAfterSeconds: APNS_RETRY_AFTER_SECONDS });
        }

        if (outcome.kind === PUSH_OUTCOMES.request_rejected) {
            const text = errorBody('apns_rejected', outcome.reason ?? undefined);
            finish(begun.key, begun.claim, 'rejected', STATUS.apns_rejected, text, null);
            return { status: STATUS.apns_rejected, headers: headers(), body: text };
        }

        const text = JSON.stringify({
            ok: true,
            status: 'accepted',
            request_id: call.requestId,
            apns_id: call.requestId,
        });
        finish(begun.key, begun.claim, 'accepted', STATUS.unauthorized === 0 ? 200 : 200, text, call.requestId);
        return bodyOf(text);
    }

    /** One request, decided in the relay's order: browser, credential, route, validation, then the work. */
    async function handle(request) {
        const url = new URL(request.url);
        const pathname = url.pathname;
        const raw = Buffer.from(await request.arrayBuffer());
        const headersPlain = {};
        for (const [name, value] of request.headers) headersPlain[name] = value;
        const record = {
            method: request.method,
            path: pathname,
            url: request.url,
            headers: headersPlain,
            text: raw.toString('utf8'),
            bytes: raw.byteLength,
            at: now(),
            status: 0,
            response: null,
        };
        requests.push(record);

        const done = (answer) => {
            record.status = answer.status;
            record.response = answer.body;
            return new Response(answer.body, { status: answer.status, headers: answer.headers });
        };

        // No legitimate caller is a browser, and a page acting with the operator's own cookies
        // is the one confused deputy this surface could have.
        if (request.headers.get('origin') !== null) return done(failure('forbidden'));

        if (pathname === '/v1/health') {
            if (request.method !== 'GET') return done(failure('method_not_allowed', { allow: 'GET' }));
            return done(bodyOf(JSON.stringify({
                ok: true,
                service: SERVICE,
                version,
                environment: environment === 'production' ? 'production' : 'development',
            })));
        }

        if (pathname === '/v1/push/voip') {
            if (request.method !== 'POST') return done(failure('method_not_allowed', { allow: 'POST' }));
            const auth = authenticate(record, request.url);
            if (!auth.ok) return done(auth.response);
            return done(pushVoip(auth.installation, record));
        }

        const devicePath = DEVICE_PATH.exec(pathname);
        if (devicePath !== null) {
            const rawDeviceId = devicePath[1] ?? '';
            if (request.method === 'PUT' || request.method === 'DELETE') {
                const auth = authenticate(record, request.url);
                if (!auth.ok) return done(auth.response);
                return done(request.method === 'PUT'
                    ? registerDevice(auth.installation, rawDeviceId, record)
                    : removeDevice(auth.installation, rawDeviceId));
            }
            return done(failure('method_not_allowed', { allow: 'PUT, DELETE' }));
        }

        return done(failure('not_found'));
    }

    /**
     * One request as the backend would make it, with the envelope already unwrapped.
     *
     * `json` sets the body and the content type; `text` sets a body and leaves the content
     * type to `headers`, which is how the cases that must not be JSON are expressed. `token`
     * defaults to this installation's credential and `null` omits the header entirely.
     */
    async function call(method, path, { json, text, headers: extraHeaders = {}, token = credential } = {}) {
        const outgoing = { ...extraHeaders };
        if (token !== null) outgoing.authorization = `Bearer ${token}`;
        let body;
        if (json !== undefined) {
            outgoing['content-type'] = outgoing['content-type'] ?? 'application/json';
            body = JSON.stringify(json);
        } else if (text !== undefined) {
            body = text;
        }
        const response = await handle(new Request(`http://relay.test${path}`, { method, headers: outgoing, body }));
        const responseText = await response.text();
        let data = {};
        try {
            data = responseText === '' ? {} : JSON.parse(responseText);
        } catch {
            data = { raw: responseText };
        }
        return { status: response.status, headers: response.headers, data, text: responseText };
    }

    let server = null;
    let base = '';
    let boundPort = 0;

    /** The same handler behind a real socket, for anything that needs a URL. */
    async function listen(port = 0) {
        if (server !== null) throw new Error('the mock relay is already listening');
        server = http.createServer((incoming, outgoing) => {
            const chunks = [];
            incoming.on('data', (chunk) => chunks.push(chunk));
            incoming.on('end', async () => {
                const hopByHop = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade', 'te', 'trailer', 'host']);
                const forwarded = {};
                for (const [name, value] of Object.entries(incoming.headers)) {
                    if (hopByHop.has(name)) continue;
                    forwarded[name] = Array.isArray(value) ? value.join(', ') : value;
                }
                const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
                const answer = await handle(new Request(`http://127.0.0.1:${boundPort}${incoming.url}`, {
                    method: incoming.method,
                    headers: forwarded,
                    body: hasBody ? Buffer.concat(chunks) : undefined,
                }));
                const responseHeaders = {};
                for (const [name, value] of answer.headers) responseHeaders[name] = value;
                outgoing.writeHead(answer.status, responseHeaders);
                outgoing.end(Buffer.from(await answer.arrayBuffer()));
            });
        });
        await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
        boundPort = server.address().port;
        base = `http://127.0.0.1:${boundPort}`;
        return { port: boundPort, base };
    }

    function close() {
        if (server === null) return;
        // A caller that used keep-alive would otherwise hold the server open, and a test run
        // would end with a socket still accepted.
        server.closeAllConnections();
        server.close();
        server = null;
    }

    return {
        credential,
        installationId,
        version,
        environment,
        devices,
        tokens,
        idempotency,
        requests,
        pushes,
        outcomes,
        limits,
        get base() {
            return base;
        },
        handle,
        call,
        listen,
        close,
        now,
        advance,
        /** Force the next push's APNs answer. A string kind, or `{kind, reason}`. */
        answerWith(...entries) {
            outcomes.push(...entries);
        },
        /** Force the limiter's answer for a budget, or `null` to allow again. */
        limit(budget, decision) {
            limits[budget] = decision;
        },
        /** Whether this deployment can sign at all. False answers 503 with a long Retry-After. */
        setApnsConfigured(value) {
            apnsConfigured = value;
        },
        /** Suspend or reactivate an installation, so a caller can be told `403 suspended`. */
        setStatus(target, status) {
            for (const held of installations.values()) {
                if (held.id === target) held.status = status;
            }
        },
    };
}

module.exports = { createMockRelay, PUSH_OUTCOMES, UUID_PATTERN };
