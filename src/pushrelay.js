'use strict';

// The Crossbar Push Relay, as this server uses it.
//
// One narrow HTTP client: a device registration, a device removal, one VoIP wake, and a
// liveness check — plus `enrolInstallation` below, the one request that obtains this
// deployment's own installation before any of the other four can be made. It owns the base
// URL, the installation Bearer, the deadline on every request, the JSON it sends and the
// decoding of what comes back — and nothing else. It does not know what a call is, who may
// ring whom, or whether a ring is still worth making: the caller decides that before it gets
// here, and the relay is a doorbell (relay docs/BACKEND_INTEGRATION.md).
//
// Two rules this file exists to keep:
//
//   * the credential is a server secret. It is never logged, never returned in an
//     outcome, and never written anywhere but the `Authorization` header of a request to
//     the relay. Nothing here logs headers, and nothing here walks an object for secrets
//     — `src/log.js` takes only the fields it is given;
//   * every request has a finite deadline. A ring that arrives late is worth less than one
//     that does not arrive, and a call that holds a socket open for a minute is worse than
//     both.
//
// Where a name, a path or a bound comes from is the relay's own documentation, which
// matches its source: the five routes are the whole surface (`GET /v1/health`,
// `POST /v1/installations`, `PUT|DELETE /v1/devices/{device_id}`, `POST /v1/push/voip` —
// relay `src/app.ts`, docs/API.md), the credential is `Bearer cbr_…`, and the field bounds
// below are the ones its validator enforces.

const crypto = require('node:crypto');

/** The relay's device-id pattern. The backend's own device ids already match it. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** A PushKit token, as the relay's registration schema requires it, before folding to lower case. */
const VOIP_TOKEN_PATTERN = /^[0-9a-fA-F]{32,512}$/;

/** `caller_id` and `caller_name` are at most 64 UTF-16 code units, with no control characters. */
const CALLER_TEXT_LIMIT = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** How long a request may take when the configuration names nothing. */
const DEFAULT_TIMEOUT_MS = 5000;

/** A response body larger than this is not one the relay sends; it is not read any further. */
const RESPONSE_LIMIT = 8192;

/**
 * The domain of the derived `request_id`.
 *
 * A string rather than a UUID namespace, because the digest below is not a v5 UUID: the
 * value only has to be stable, per (call, device), and UUID-shaped.
 */
const REQUEST_ID_DOMAIN = 'crossbar.push-relay.request-id.v1';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The idempotency key for one device's ring of one call.
 *
 * **Derived, not stored**: `sha256(domain:call_id:device_id)`, with the version and variant
 * bits set so the value is a well-formed v4 UUID. The same (call, device) pair therefore
 * produces the same id on every attempt, which is the property the relay's duplicate
 * suppression is written for — a retry after a timeout carries the id it was refused with,
 * with no row to keep in step and nothing to lose across a restart. Version 4 rather than 8
 * because this value travels on to Apple as the `apns-id` header, and v4 is the form APNs
 * documents; the relay itself validates the shape only (relay `UUID_PATTERN`).
 *
 * It is per *device* as well as per call because the relay keys a push on
 * `(installation_id, request_id)`, not on the device: one id shared by a fan-out to two
 * phones would be refused with `409` for the second (relay docs/BACKEND_INTEGRATION.md §9).
 */
function requestIdFor(callId, deviceId) {
    const digest = crypto.createHash('sha256')
        .update(`${REQUEST_ID_DOMAIN}:${String(callId).toLowerCase()}:${String(deviceId)}`)
        .digest('hex')
        .slice(0, 32)
        .split('');
    digest[12] = '4';
    digest[16] = ((parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
    const hex = digest.join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A refusal this process made without asking the relay: a bad argument, or no configuration. */
function localRefusal(error) {
    return { ok: false, status: 0, error, retryAfterSeconds: null, permanent: true, deviceGone: false, body: null };
}

/** An answer from the relay. `status` is 0 only for a request that never got one. */
function answered(ok, status, error, { retryAfterSeconds = null, permanent = false, deviceGone = false, body = null } = {}) {
    return { ok, status, error, retryAfterSeconds, permanent, deviceGone, body };
}

/**
 * Whether re-sending the same request could ever succeed.
 *
 * Read off the relay's refusal vocabulary (relay docs/API.md): `429` and `503` are temporary
 * by definition and carry `Retry-After`; `409 request_in_progress` is another attempt holding
 * the claim and is answered with "ask again with the same `request_id`". A request that never
 * reached the relay is *unknown* rather than failed — it may have been recorded — so it is
 * retryable for the same reason. Everything else is a property of the request, the credential
 * or the deployment, and asking again changes nothing.
 */
function permanence(status, error) {
    if (status === 429 || status === 503) return false;
    if (status === 409 && error === 'request_in_progress') return false;
    return true;
}

/** `Retry-After` in whole seconds, as the relay sends it. Absent or unreadable is `null`. */
function retryAfter(header) {
    const seconds = Number.parseInt(String(header || ''), 10);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * A name a lock screen can draw and the relay will accept.
 *
 * The bound is the relay's, and it is enforced by a `400` — a display name longer than 64
 * code units, or one carrying a control character, is a push that is never sent and a phone
 * that never rings. Clipping is the client's job because the directory is not written for
 * the wire: a person's display name is theirs, and the ceiling belongs to the transport.
 */
function callerText(value) {
    return String(value ?? '').replace(CONTROL_CHARACTERS, '').slice(0, CALLER_TEXT_LIMIT);
}

/** The scheme a refused origin named, and why it is not being used. */
const ORIGIN_REFUSALS = {
    plaintext: 'http: would send the installation credential in cleartext; only a loopback relay may use it',
    not_http: 'the relay is addressed over https: only',
    unparseable: 'the setting is not a URL',
};

/** Whether a host resolves to this machine, where a plaintext origin cannot be read off the wire. */
function isLoopbackHost(hostname) {
    // A bracketed IPv6 literal arrives as `[::1]`; Node folds the rest to lower case.
    const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (host === 'localhost' || host === '::1') return true;
    // The whole 127/8 block, and only that: `127.0.0.1.example.com` is somebody else's host.
    const octets = host.split('.');
    return octets.length === 4 && octets[0] === '127'
        && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * The relay's origin, and — when there is none — the scheme this client will not use.
 *
 * `https:` is the only scheme that can carry the installation credential: the relay
 * authenticates every call with a `Bearer` secret that authorises ringing every phone this
 * installation has registered, so a plaintext `http:` relay hands that secret to anything on
 * the path — every registration and every ring, for the life of the deployment, with nothing
 * in the traffic looking wrong. A loopback `http:` relay is the one exception: a deployment on
 * this machine has no path on which to be read, and it is how the relay's own contract tests
 * and a local relay are reached without a certificate. Everything else — a non-loopback
 * `http:`, a misspelled or non-HTTP scheme, a value that is not a URL — is refused at
 * construction, where it is one log line, rather than on every push, where it is a phone that
 * never rings for a reason nobody can see.
 */
function originOf(value) {
    if (!value) return { origin: '', refusal: null, scheme: '' };
    let url;
    try {
        url = new URL(value);
    } catch {
        return { origin: '', refusal: 'unparseable', scheme: '' };
    }
    if (url.protocol === 'https:') return { origin: url.origin, refusal: null, scheme: url.protocol };
    if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) {
        return { origin: url.origin, refusal: null, scheme: url.protocol };
    }
    return { origin: '', refusal: url.protocol === 'http:' ? 'plaintext' : 'not_http', scheme: url.protocol };
}

// ── Obtaining an installation, which happens once rather than on every request ──
//
// Everything above runs while the deployment is serving: it has an installation already, and
// what it does with one is register devices and ring them. This is the other end of the
// lifecycle — the one request that obtains the installation in the first place — and it is
// used by `src/setup.js` rather than by the running server.

/** The relay's installation credential, exactly as `POST /v1/installations` issues it. */
const CREDENTIAL_PATTERN = /^cbr_[A-Za-z0-9_-]{43}$/;

/** The relay's id for an installation, `ins_…` — the value a log line names it by. */
const INSTALLATION_ID_PATTERN = /^ins_[A-Za-z0-9_-]{8,80}$/;

/** `label` is the relay's own bound: 200 UTF-16 code units, no control characters. */
const LABEL_LIMIT = 200;

/** How long the one enrolment request may take. Longer than a ring: it happens once, by hand. */
const ENROLMENT_TIMEOUT_MS = 10000;

/** A label the relay accepts, or `''`: it is the enrolling server's own words. */
function labelText(value) {
    return String(value ?? '').replace(CONTROL_CHARACTERS, '').slice(0, LABEL_LIMIT);
}

/**
 * Obtain this deployment's own installation from a relay that takes self-service enrolments.
 *
 * One unauthenticated `POST <relay>/v1/installations`, and the answer is the three values the
 * deployment needs: the relay's URL, its id for the installation, and the credential — which is
 * shown once and stored by the relay only as a digest, so there is nothing to read back and
 * nothing to recover (relay `docs/API.md`).
 *
 * **Deliberately one attempt.** The route takes no idempotency key, so a retry after an answer
 * that was not received creates a *second* installation whose credential nobody holds. A
 * transport failure is therefore reported as `unreachable` — "unknown" rather than "failed" —
 * and the caller decides what to say about it; nothing here loops.
 *
 * The `relay_url` in the answer is the relay's own report of the origin the request reached, and
 * it is the one that must be stored: the address dialled and the address answered are not
 * necessarily spelled the same (relay `docs/BACKEND_INTEGRATION.md`).
 *
 * Returns `{ ok: true, relayUrl, installationId, credential }`, or
 * `{ ok: false, reason, status, retryAfterSeconds, relayUrl }` where `reason` is the relay's own
 * error code (`enrolment_closed`, `rate_limited`, …), `unreachable` for a request that got no
 * answer, or `unexpected_answer` for a body that is not the documented shape.
 */
async function enrolInstallation({ relayUrl, label = '', fetch: fetchImpl = globalThis.fetch, timeoutMs = ENROLMENT_TIMEOUT_MS } = {}) {
    const configured = originOf(relayUrl);
    if (!configured.origin) {
        return { ok: false, reason: 'unusable_url', status: 0, retryAfterSeconds: null, relayUrl: '' };
    }
    const word = labelText(label);
    const request = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(word ? { label: word } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        // A redirect is not a relay answering. Following one could hand the request — and the
        // credential that comes back — to a host the operator never named, so nothing here is
        // worth following.
        redirect: 'error',
    };

    let response;
    try {
        response = await fetchImpl(`${configured.origin}/v1/installations`, request);
    } catch {
        // A request that never got an answer: unknown, not failed, and not repeated.
        return { ok: false, reason: 'unreachable', status: 0, retryAfterSeconds: null, relayUrl: configured.origin };
    }

    let answer = null;
    try {
        const text = (await response.text()).slice(0, RESPONSE_LIMIT);
        const parsed = text ? JSON.parse(text) : null;
        answer = parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        answer = null;
    }

    if (response.status === 201 && answer?.ok === true) {
        const credential = String(answer.credential ?? '');
        const installationId = String(answer.installation_id ?? '');
        // The same scheme rule the running client applies: an installation credential must not
        // travel to a plaintext relay, so a relay that reports one is not usable.
        const reported = originOf(String(answer.relay_url ?? ''));
        if (CREDENTIAL_PATTERN.test(credential) && INSTALLATION_ID_PATTERN.test(installationId) && reported.origin) {
            return { ok: true, relayUrl: reported.origin, installationId, credential };
        }
        return {
            ok: false, reason: 'unexpected_answer', status: response.status, retryAfterSeconds: null,
            relayUrl: configured.origin,
        };
    }

    return {
        ok: false,
        reason: typeof answer?.error === 'string' ? answer.error : 'unexpected_answer',
        status: response.status,
        retryAfterSeconds: retryAfter(response.headers.get('retry-after')),
        relayUrl: configured.origin,
    };
}

function createPushRelayClient({ config, log, fetch: fetchImpl = globalThis.fetch }) {
    const configured = originOf(config.pushRelayUrl);
    const baseUrl = configured.origin;
    if (configured.refusal) {
        // Named here rather than met on the first push: with no origin there is no relay, and
        // this line is the only thing that separates "nobody configured it" from "it was
        // configured and refused".
        log.warn('push_relay_origin_refused', {
            scheme: configured.scheme || null,
            reason: configured.refusal,
            message: ORIGIN_REFUSALS[configured.refusal],
        });
    }
    const credential = config.pushRelayToken || '';
    // The relay derives the installation from the credential and has no field for it, so this
    // value is never sent: it is here so a log line can name the installation a refusal came
    // from when one operator runs more than one.
    const installationId = config.pushRelayInstallationId || '';
    const timeoutMs = Number.isFinite(config.pushRelayTimeoutMs) && config.pushRelayTimeoutMs > 0
        ? config.pushRelayTimeoutMs
        : DEFAULT_TIMEOUT_MS;

    /** Whether this deployment can ring a phone at all. Without both, nothing is sent. */
    const enabled = Boolean(baseUrl && credential);

    /** The relay's answer, as a JSON object, or `null` when it sent none that could be read. */
    async function readBody(response) {
        try {
            const text = (await response.text()).slice(0, RESPONSE_LIMIT);
            if (!text) return null;
            const parsed = JSON.parse(text);
            return typeof parsed === 'object' ? parsed : null;
        } catch {
            // A body that is not the documented shape is still an answer; the status is the
            // part that is always there.
            return null;
        }
    }

    /**
     * One request, with the deadline, the credential and the decoding in one place.
     *
     * `auth` is false for the health route alone: the relay reads no credential there, and
     * sending one to an endpoint that does not need it is a secret on a path it has no
     * business travelling.
     *
     * `deviceScoped` marks the two routes that address one device's *registration*. It is
     * what makes their `404 not_found` readable: a `404` there is not "no such path", it is
     * the relay saying it has no registration for this device (`API.md`, `POST /v1/push/voip`
     * and `DELETE /v1/devices/{id}`), which is the only way a backend can learn of a `410`
     * that was sent but whose answer never arrived.
     */
    async function call(method, path, { json, auth = true, deviceId = null, deviceScoped = false } = {}) {
        const endpoint = `${method} ${path}`;
        const headers = { accept: 'application/json' };
        if (auth) headers.authorization = `Bearer ${credential}`;
        let body;
        if (json !== undefined) {
            body = JSON.stringify(json);
            // Exactly `application/json`: the relay refuses a `charset` parameter with a 415,
            // because JSON is UTF-8 by definition.
            headers['content-type'] = 'application/json';
        }

        let response;
        try {
            response = await fetchImpl(new URL(path, baseUrl).toString(), {
                method,
                headers,
                body,
                signal: AbortSignal.timeout(timeoutMs),
                // A redirect to somewhere else is not a relay answering. Nothing here is
                // worth following, and a credential is not worth forwarding.
                redirect: 'error',
            });
        } catch (error) {
            log.warn('push_relay_unreachable', {
                endpoint,
                deviceId,
                message: String(error?.message || error).slice(0, 120),
            });
            return answered(false, 0, 'unreachable', { permanent: false });
        }

        const parsed = await readBody(response);
        if (response.status >= 200 && response.status < 300) {
            return answered(true, response.status, '', { body: parsed });
        }

        const error = typeof parsed?.error === 'string' ? parsed.error : 'unknown_error';
        // Two answers say the relay holds no registration for this device. `410` is APNs
        // reporting the token dead; `404` is the relay itself not finding the device — never
        // registered, already removed, marked inactive by an APNs refusal, or belonging to
        // another installation. All of those mean the same thing to the caller: this token
        // cannot be rung from here. A `410` whose answer was lost is *only* ever learned from
        // the second, which is why a transport-failed ring is retried with its own
        // `request_id` and why that retry can come back `404` (relay `API.md`, "The
        // idempotency contract", last bullet).
        const deviceGone = deviceScoped
            && ((response.status === 410 && error === 'device_unregistered')
                || (response.status === 404 && error === 'not_found'));
        const outcome = answered(false, response.status, error, {
            retryAfterSeconds: retryAfter(response.headers.get('retry-after')),
            permanent: permanence(response.status, error),
            deviceGone,
            body: parsed,
        });
        log.warn('push_relay_refused', {
            endpoint,
            deviceId,
            status: outcome.status,
            error: outcome.error,
            retryAfterSeconds: outcome.retryAfterSeconds,
            installation: installationId || null,
        });
        return outcome;
    }

    /**
     * Tells the relay where a device's PushKit token is.
     *
     * One `PUT` per device id, so a token that rotates is an update at the same address
     * rather than a second device (relay docs/API.md, "Register a device's PushKit token, or
     * rotate it"). A `409 token_conflict` is not a bug to retry: the token has exactly one
     * owner, and it means the phone has not been released by whoever registered it first.
     */
    async function registerDevice({ deviceId, token }) {
        if (!enabled) return localRefusal('not_configured');
        const id = String(deviceId || '');
        if (!DEVICE_ID_PATTERN.test(id)) return localRefusal('invalid_device_id');
        const value = String(token || '');
        if (!VOIP_TOKEN_PATTERN.test(value)) return localRefusal('invalid_token');
        return call('PUT', `/v1/devices/${id}`, { json: { voip_token: value }, deviceId: id });
    }

    /**
     * Takes a device out of the relay, which is also what frees its token for the next
     * server that presents it.
     *
     * A `404 not_found` means the relay has no registration for this device — it never had
     * one, or this already happened, or the device belongs to another installation — and it
     * is "done" rather than a failure: there is nothing left to free. The outcome keeps
     * `ok: false` (the relay removed nothing) and names the status, so the caller that owns
     * the retry decision reads it as done without pretending a removal happened.
     */
    async function removeDevice({ deviceId }) {
        if (!enabled) return localRefusal('not_configured');
        const id = String(deviceId || '');
        if (!DEVICE_ID_PATTERN.test(id)) return localRefusal('invalid_device_id');
        return call('DELETE', `/v1/devices/${id}`, { deviceId: id, deviceScoped: true });
    }

    /**
     * Rings one phone: one call, one device, one push.
     *
     * The six scalars are the whole body, and the relay refuses anything else, including a
     * field it could have ignored. `request_id` is the caller's, and reusing it for the same
     * call and device is what makes a retry safe rather than a second ring
     * (`requestIdFor` above).
     */
    async function sendIncomingCall({ deviceId, requestId, callId, callerId, callerName, hasVideo }) {
        if (!enabled) return localRefusal('not_configured');
        const id = String(deviceId || '');
        if (!DEVICE_ID_PATTERN.test(id)) return localRefusal('invalid_device_id');
        const request = String(requestId || '').toLowerCase();
        if (!UUID_PATTERN.test(request)) return localRefusal('invalid_request_id');
        const callRef = String(callId || '').toLowerCase();
        if (!UUID_PATTERN.test(callRef)) return localRefusal('invalid_call_id');
        return call('POST', '/v1/push/voip', {
            json: {
                request_id: request,
                device_id: id,
                call_id: callRef,
                caller_id: callerText(callerId),
                caller_name: callerText(callerName),
                // Strictly a boolean: the relay refuses `"true"`, so that `has_video` cannot
                // mean two things depending on who serialised it.
                has_video: hasVideo === true,
            },
            deviceId: id,
            deviceScoped: true,
        });
    }

    /**
     * Whether the relay is answering, which is not the same as whether it will ring.
     *
     * The relay reads no credential for this and performs no I/O (relay docs/API.md), so a
     * `200` says the deployment is reachable and says nothing about APNs or about this
     * installation's credential.
     */
    async function healthCheck() {
        if (!baseUrl) return localRefusal('not_configured');
        return call('GET', '/v1/health', { auth: false });
    }

    return {
        enabled,
        installationId,
        timeoutMs,
        registerDevice,
        removeDevice,
        sendIncomingCall,
        healthCheck,
        requestIdFor,
    };
}

module.exports = { createPushRelayClient, enrolInstallation, requestIdFor };
