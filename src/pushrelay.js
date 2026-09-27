'use strict';

// The Crossbar Push Relay, as this server uses it.
//
// One narrow HTTP client: a device registration, a device removal, one VoIP wake, and a
// liveness check. It owns the base URL, the installation Bearer, the deadline on every
// request, the JSON it sends and the decoding of what comes back — and nothing else. It
// does not know what a call is, who may ring whom, or whether a ring is still worth
// making: the caller decides that before it gets here, and the relay is a doorbell
// (relay docs/BACKEND_INTEGRATION.md).
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
// matches its source: the four routes are the whole surface (`GET /v1/health`,
// `PUT|DELETE /v1/devices/{device_id}`, `POST /v1/push/voip` — relay `src/app.ts`, docs/API.md),
// the credential is `Bearer cbr_…`, and the field bounds below are the ones its validator
// enforces.

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

/**
 * The relay's origin, or empty when the setting is missing or is not an HTTP one.
 *
 * `http:` is allowed on purpose: the relay is reachable over plain HTTP in a local
 * deployment, and refusing to speak to one would make the client untestable without a
 * certificate. A deployment that rings real phones names an `https:` worker, and a
 * misspelled scheme is refused here rather than turning every push into a transport error.
 */
function originOf(value) {
    if (!value) return '';
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : '';
    } catch {
        return '';
    }
}

function createPushRelayClient({ config, log, fetch: fetchImpl = globalThis.fetch }) {
    const baseUrl = originOf(config.pushRelayUrl);
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
     */
    async function call(method, path, { json, auth = true, deviceId = null } = {}) {
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
        const outcome = answered(false, response.status, error, {
            retryAfterSeconds: retryAfter(response.headers.get('retry-after')),
            permanent: permanence(response.status, error),
            deviceGone: response.status === 410 && error === 'device_unregistered',
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
     * server that presents it. A `404` means the relay does not have it — because it never
     * did, or because this already happened — and the caller reads that as done.
     */
    async function removeDevice({ deviceId }) {
        if (!enabled) return localRefusal('not_configured');
        const id = String(deviceId || '');
        if (!DEVICE_ID_PATTERN.test(id)) return localRefusal('invalid_device_id');
        return call('DELETE', `/v1/devices/${id}`, { deviceId: id });
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

module.exports = { createPushRelayClient, requestIdFor };
