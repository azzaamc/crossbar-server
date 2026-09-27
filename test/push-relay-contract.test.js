'use strict';

// The wire contract with the Crossbar Push Relay, pinned from this server's side.
//
// Nothing here reaches the relay. It is a Cloudflare Worker holding the only Apple signing
// key, and a local run cannot even speak HTTP/2 to APNs — so `helpers/mock-relay.js`
// reproduces the relay's documented side of the wire from the relay's own source, and these
// tests assert the shapes this server must send it and the answers it must tolerate. A
// backend that builds a plausible-looking request Apple would refuse fails here instead of
// on a phone that never rings.
//
// Two kinds of test live here:
//
//   * the relay's contract as the mock implements it, driven directly over the wire — these
//     are what the backend's client is measured against, and they run today;
//   * the backend client itself (src/pushrelay.js). Those four are skipped with a named reason
//     when that file is absent, rather than importing a path that does not exist and failing
//     for a reason that says nothing; it is present in this tree, so they run.
//
// The relay is VoIP-only: `POST /v1/push/voip` is the call wake. The missed-call alert stays
// on this server's direct APNs path, and there is deliberately nothing here about it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createMockRelay, PUSH_OUTCOMES, UUID_PATTERN } = require('./helpers/mock-relay');

/** The ids the backend already mints: 20 characters, opaque, and valid on both sides. */
const DEVICE_A = 'dev_RhB3R7UuH9TqbmBJ';
const DEVICE_B = 'dev_jo66Y10591oq3rhw';

/** PushKit tokens are lowercase hex, and never an identity. */
const TOKENS = { [DEVICE_A]: 'a'.repeat(64), [DEVICE_B]: 'b'.repeat(64) };

/** A call id the app can parse, because it reads it with `UUID(uuidString:)`. */
const CALL_ID = 'b7a1c2d3-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const CALLER_ID = 'user_01HQ8Z5V9K3W2M4N6P7Q8R9S0T';
const CALLER_NAME = 'Amina Yusuf';

function requestId() {
    return crypto.randomUUID();
}

function register(relay, deviceId, token) {
    return relay.call('PUT', `/v1/devices/${deviceId}`, { json: { voip_token: token } });
}

/** One ring, with the six scalars and nothing else — the API has no other parameters. */
function push(relay, overrides = {}) {
    return relay.call('POST', '/v1/push/voip', {
        json: {
            request_id: requestId(),
            device_id: DEVICE_A,
            call_id: CALL_ID,
            caller_id: CALLER_ID,
            caller_name: CALLER_NAME,
            has_video: false,
            ...overrides,
        },
    });
}

/** A relay with both of a call's two devices registered. */
async function withDevices(options = {}) {
    const relay = createMockRelay(options);
    await register(relay, DEVICE_A, TOKENS[DEVICE_A]);
    await register(relay, DEVICE_B, TOKENS[DEVICE_B]);
    return relay;
}

// ---------------------------------------------------------------------------------------
// The relay's contract, driven directly.
// ---------------------------------------------------------------------------------------

test('health is unauthenticated and says nothing about this installation', async () => {
    const relay = createMockRelay();

    const health = await relay.call('GET', '/v1/health', { token: null });
    assert.equal(health.status, 200);
    assert.deepEqual(Object.keys(health.data).sort(), ['environment', 'ok', 'service', 'version']);
    assert.equal(health.data.service, 'crossbar-push-relay');

    // The URL space is exactly four routes: anything else is the same 404 a missing device gets.
    const nowhere = await relay.call('GET', '/v1/devices', { token: null });
    assert.equal(nowhere.status, 404);

    const wrongMethod = await relay.call('POST', '/v1/health', { token: null });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET');
});

test('a registration the relay accepts is one device id and one token', async () => {
    const relay = createMockRelay();

    const first = await register(relay, DEVICE_A, TOKENS[DEVICE_A]);
    assert.equal(first.status, 200);
    assert.deepEqual(first.data, { ok: true, device_id: DEVICE_A, registered: true });

    // A PushKit rotation is an upsert at the same device id, not a second device.
    const rotated = await register(relay, DEVICE_A, 'c'.repeat(64));
    assert.equal(rotated.status, 200);
    assert.equal(relay.devices.size, 1, 'a rotation is an update, not a new device');
    assert.equal(relay.devices.get(`${relay.installationId}\u0000${DEVICE_A}`).token, 'c'.repeat(64));
    // ...and the token it replaced is nobody's, so another device may hold it.
    assert.equal(relay.tokens.has(TOKENS[DEVICE_A]), false);
    assert.equal((await register(relay, DEVICE_B, TOKENS[DEVICE_A])).status, 200);
});

test('a registration the relay refuses is refused with one answer and nothing written', async () => {
    const relay = createMockRelay();

    // An unknown field is refused rather than ignored: the fields this API does not have are
    // the things it deliberately will not do — a topic, a host, a raw payload.
    const extraField = await relay.call('PUT', `/v1/devices/${DEVICE_A}`, {
        json: { voip_token: TOKENS[DEVICE_A], apns_topic: 'com.example.Crossbar' },
    });
    assert.equal(extraField.status, 400);
    assert.deepEqual(extraField.data, { error: 'bad_request' });

    // Not a PushKit token. The token is never an identity, so a device id is never a token.
    assert.equal((await register(relay, DEVICE_A, 'not-a-token')).status, 400);
    assert.equal((await register(relay, DEVICE_A, 'ab'.repeat(8))).status, 400, 'too short to be one');

    // A credential fits the device-id pattern by shape, and the device id appears in a path, so
    // a credential in the path is refused — by the auth layer first, because a credential that
    // has already leaked into a URL is a request the relay will not act on at all.
    const credentialInPath = await relay.call('PUT', `/v1/devices/${relay.credential}`, {
        json: { voip_token: TOKENS[DEVICE_A] },
    });
    assert.equal(credentialInPath.status, 401);
    assert.deepEqual(credentialInPath.data, { error: 'unauthorized' });

    // The body must be exactly `application/json`; a charset parameter is an ambiguity, not a
    // feature.
    const wrongType = await relay.call('PUT', `/v1/devices/${DEVICE_A}`, {
        text: JSON.stringify({ voip_token: TOKENS[DEVICE_A] }),
    });
    assert.equal(wrongType.status, 415);

    assert.equal(relay.devices.size, 0, 'none of the refusals wrote a device');
});

test('a token that already has an owner is refused, and the owner keeps it', async () => {
    const relay = await withDevices();

    // The same token presented for a second device — which in practice is a phone that moved
    // from one installation to another. Nothing was written: `UNIQUE(token)`, first writer wins.
    const second = await register(relay, 'dev_movedFromAnother', TOKENS[DEVICE_A]);
    assert.equal(second.status, 409);
    assert.deepEqual(second.data, { error: 'token_conflict' });
    assert.equal(relay.devices.size, 2);
    assert.equal(relay.devices.get(`${relay.installationId}\u0000${DEVICE_A}`).token, TOKENS[DEVICE_A]);

    const refused = await relay.call('DELETE', '/v1/devices/dev_movedFromAnother');
    assert.equal(refused.status, 404);

    // A removal is how the owner releases it, and then it can be registered elsewhere.
    const removed = await relay.call('DELETE', `/v1/devices/${DEVICE_A}`);
    assert.deepEqual(removed.data, { ok: true, device_id: DEVICE_A, removed: true });
    assert.equal((await register(relay, 'dev_movedFromAnother', TOKENS[DEVICE_A])).status, 200);
});

test('a push carries the namespaced payload, field for field', async () => {
    const relay = await withDevices();

    const id = requestId();
    const answer = await push(relay, { device_id: DEVICE_A, request_id: id, has_video: true });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.data, { ok: true, status: 'accepted', request_id: id, apns_id: id });

    const [sent] = relay.pushes;
    assert.equal(sent.deviceId, DEVICE_A);
    assert.equal(sent.apnsToken, TOKENS[DEVICE_A], 'the token the relay holds is the one it rings');
    assert.deepEqual(sent.payload, {
        aps: { 'content-available': 1 },
        crossbar: {
            v: 1,
            type: 'incoming_call',
            installation_id: relay.installationId,
            call_id: CALL_ID,
            caller_id: CALLER_ID,
            caller_name: CALLER_NAME,
            has_video: true,
        },
    });
    // The decoder walks these keys, and `has_video` is what tells the lock screen what to draw.
    assert.deepEqual(Object.keys(sent.payload), ['aps', 'crossbar']);
    assert.deepEqual(Object.keys(sent.payload.crossbar), [
        'v', 'type', 'installation_id', 'call_id', 'caller_id', 'caller_name', 'has_video',
    ]);
    // A VoIP push is not a notification: an alert would be a second thing claiming the ring's
    // attention, and `content-available` is what wakes PushKit.
    assert.equal('alert' in sent.payload.aps, false);
    // Nothing about the call travels except the six scalars: no SDP, no URL, no credential.
    assert.equal(JSON.stringify(sent.payload).includes(relay.credential), false);
});

test('a push the relay will not accept is refused before anything is sent', async () => {
    const relay = await withDevices();

    // A call id the app could not parse is a push that arrives and is discarded, which is worse
    // than one that is refused — the app reads it with `UUID(uuidString:)`.
    assert.equal((await push(relay, { call_id: 'not-a-uuid' })).status, 400);
    assert.equal((await push(relay, { request_id: 'not-a-uuid' })).status, 400);
    // `"true"` would make `has_video` mean two different things.
    assert.equal((await push(relay, { has_video: 'true' })).status, 400);
    assert.equal((await push(relay, { extra: 'field' })).status, 400);
    assert.equal((await push(relay, { caller_name: 'x'.repeat(65) })).status, 400);
    // A device the relay does not know, or no longer pushes to.
    assert.equal((await push(relay, { device_id: 'dev_unknown000000' })).status, 404);
    // A credential is never a device id here either.
    assert.equal((await push(relay, { device_id: relay.credential })).status, 400);

    assert.equal(relay.pushes.length, 0, 'nothing reached APNs');
});

test('two devices of one call are woken, each with its own request_id', async () => {
    const relay = await withDevices();

    const first = await push(relay, { device_id: DEVICE_A, request_id: requestId() });
    const second = await push(relay, { device_id: DEVICE_B, request_id: requestId() });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(relay.pushes.map((sent) => sent.deviceId), [DEVICE_A, DEVICE_B]);
    assert.notEqual(relay.requests[0].text, relay.requests[1].text);
});

test('one shared request_id fans out to one phone and then conflicts', async () => {
    const relay = await withDevices();
    const shared = requestId();

    const first = await push(relay, { device_id: DEVICE_A, request_id: shared });
    const second = await push(relay, { device_id: DEVICE_B, request_id: shared });

    assert.equal(first.status, 200);
    // Idempotency is keyed `(installation_id, request_id)` and not per device, so the second
    // device of the same call is refused. This is the whole reason a request id is derived per
    // target device: one id for a fan-out is one phone rung and one that never rings.
    assert.equal(second.status, 409);
    assert.deepEqual(second.data, { error: 'idempotency_conflict' });
    assert.deepEqual(relay.pushes.map((sent) => sent.deviceId), [DEVICE_A]);
});

test('a retry with the same request_id and the same meaning replays instead of pushing', async () => {
    const relay = await withDevices();
    const id = requestId();
    const body = { device_id: DEVICE_A, request_id: id, has_video: true };

    const first = await push(relay, body);
    assert.equal(first.status, 200);
    // Same values, different key order: duplicate suppression is over what the request means,
    // not over its bytes, so a client that serialises differently is not a conflicting caller.
    const retry = await relay.call('POST', '/v1/push/voip', {
        json: {
            has_video: true,
            caller_name: CALLER_NAME,
            caller_id: CALLER_ID,
            call_id: CALL_ID,
            device_id: DEVICE_A,
            request_id: id,
        },
    });

    assert.equal(retry.status, 200);
    assert.equal(retry.text, first.text, 'the same envelope, byte for byte');
    assert.equal(relay.pushes.length, 1, 'Apple was not asked twice');

    // A new call is a new id; reusing one for a different body is a caller bug, because two
    // calls collapsing into one id would silently discard one of them.
    const different = await push(relay, { device_id: DEVICE_A, request_id: id, caller_name: 'Someone Else' });
    assert.equal(different.status, 409);
    assert.deepEqual(different.data, { error: 'idempotency_conflict' });
    assert.equal(relay.pushes.length, 1);

    // The record is a window, not a permanent memory: past it the key is free again, so a
    // deliberate retry a day later sends rather than being answered from a record nobody kept.
    relay.advance(25 * 60 * 60 * 1000);
    const muchLater = await push(relay, body);
    assert.equal(muchLater.status, 200);
    assert.equal(relay.pushes.length, 2);
});

test('each APNs outcome reaches the caller as its own answer', async () => {
    const relay = await withDevices();

    const acceptedId = requestId();
    const accepted = await push(relay, { request_id: acceptedId });
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.data, { ok: true, status: 'accepted', request_id: acceptedId, apns_id: acceptedId });

    relay.answerWith(PUSH_OUTCOMES.transient);
    const transient = await push(relay, { request_id: requestId() });
    assert.equal(transient.status, 503);
    assert.deepEqual(transient.data, { error: 'apns_unavailable' });
    assert.ok(Number(transient.headers.get('retry-after')) >= 1, 'the caller is told when to come back');

    relay.answerWith({ kind: PUSH_OUTCOMES.request_rejected, reason: 'BadTopic' });
    const rejected = await push(relay, { request_id: requestId() });
    assert.equal(rejected.status, 502);
    assert.deepEqual(rejected.data, { error: 'apns_rejected', reason: 'BadTopic' });

    relay.answerWith({ kind: PUSH_OUTCOMES.device_invalid, reason: 'Unregistered' });
    const gone = await push(relay, { device_id: DEVICE_A, request_id: requestId() });
    assert.equal(gone.status, 410);
    assert.deepEqual(gone.data, { error: 'device_unregistered' });
    // The relay has already marked it inactive, so every later push answers 404 — which is why
    // a 410 is a signal to forget the token rather than to retry the call.
    assert.equal((await push(relay, { device_id: DEVICE_A, request_id: requestId() })).status, 404);
    // ...and registering again reactivates it, which is Apple's own rule.
    await register(relay, DEVICE_A, TOKENS[DEVICE_A]);
    assert.equal((await push(relay, { device_id: DEVICE_A, request_id: requestId() })).status, 200);
});

test('the allowance is the last thing consulted, so a replay is never a rate limit', async () => {
    const relay = await withDevices();
    const id = requestId();

    // A push refused for the allowance leaves nothing in flight: the retry after `Retry-After`
    // genuinely sends rather than being answered about a ring that never happened.
    relay.limit('push', { allowed: false, retryAfterSeconds: 30, limit: 'burst' });
    const limited = await push(relay, { request_id: id });
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.data, { error: 'rate_limited' });
    assert.equal(limited.headers.get('retry-after'), '30');
    assert.equal(relay.pushes.length, 0);

    relay.limit('push', null);
    const afterBackoff = await push(relay, { request_id: id });
    assert.equal(afterBackoff.status, 200, 'the same request id is not held against a push that never happened');
    assert.equal(relay.pushes.length, 1);

    // A retry of an accepted push is answered from its record even when the allowance is spent,
    // because the replay is decided before the limiter is consulted.
    relay.limit('push', { allowed: false, retryAfterSeconds: 30, limit: 'daily' });
    const replay = await push(relay, { request_id: id });
    assert.equal(replay.status, 200);
    assert.equal(relay.pushes.length, 1, 'still one push');

    // The two allowances are separate counters, so a registration loop spends the write one and
    // cannot be the reason a call does not ring. It is refused before anything is written.
    relay.limit('device', { allowed: false, retryAfterSeconds: 12, limit: 'burst' });
    const refusedWrite = await register(relay, 'dev_newDevice00000', 'd'.repeat(64));
    assert.equal(refusedWrite.status, 429);
    assert.deepEqual(refusedWrite.data, { error: 'rate_limited' });
    assert.equal(refusedWrite.headers.get('retry-after'), '12');
    assert.equal(relay.devices.has(`${relay.installationId}\u0000dev_newDevice00000`), false);
    relay.limit('device', null);
});

test('a transient failure stays retryable; a permanent one does not', async () => {
    const relay = await withDevices();

    // APNs could not take it now. The relay records the attempt as failed rather than terminal,
    // so the caller's retry — same request id, same body — really sends.
    const transientId = requestId();
    relay.answerWith(PUSH_OUTCOMES.transient);
    const first = await push(relay, { request_id: transientId });
    assert.equal(first.status, 503);
    const retried = await push(relay, { request_id: transientId });
    assert.equal(retried.status, 200);
    assert.equal(relay.pushes.length, 2, 'the retry reached APNs');

    // A `device_invalid` is terminal: the device is inactive, so retrying is a 404 rather than
    // a second attempt, and the token is the caller's to forget.
    const goneId = requestId();
    relay.answerWith(PUSH_OUTCOMES.device_invalid);
    assert.equal((await push(relay, { request_id: goneId })).status, 410);
    assert.equal((await push(relay, { request_id: goneId })).status, 404);
    assert.equal(relay.pushes.length, 3);

    // A deployment with no APNs key answers 503 as well, and it is a different 503: nothing a
    // caller does fixes it, so the wait it names is minutes rather than seconds.
    const keyless = await withDevices();
    keyless.setApnsConfigured(false);
    const unconfigured = await push(keyless, { request_id: requestId() });
    assert.equal(unconfigured.status, 503);
    assert.deepEqual(unconfigured.data, { error: 'apns_unavailable' });
    assert.ok(Number(unconfigured.headers.get('retry-after')) > 60);
    assert.equal(keyless.pushes.length, 0);
});

test('an invalid credential is refused and says so', async () => {
    const relay = createMockRelay();

    const wrong = await relay.call('PUT', `/v1/devices/${DEVICE_A}`, {
        json: { voip_token: TOKENS[DEVICE_A] },
        token: `cbr_${'x'.repeat(43)}`,
    });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.data, { error: 'unauthorized' });
    assert.equal(wrong.headers.get('www-authenticate'), 'Bearer realm="crossbar-push-relay"');

    const malformed = await relay.call('PUT', `/v1/devices/${DEVICE_A}`, {
        json: { voip_token: TOKENS[DEVICE_A] },
        token: 'cbr_short',
    });
    assert.equal(malformed.status, 401);

    const absent = await relay.call('PUT', `/v1/devices/${DEVICE_A}`, {
        json: { voip_token: TOKENS[DEVICE_A] },
        token: null,
    });
    assert.equal(absent.status, 401);

    // A credential anywhere but the Authorization header means the caller has already leaked it
    // somewhere it does not belong, so the whole request is refused rather than ignoring it.
    const inUrl = await relay.call('PUT', `/v1/devices/${DEVICE_A}?token=${relay.credential}`, {
        json: { voip_token: TOKENS[DEVICE_A] },
    });
    assert.equal(inUrl.status, 401);

    // A browser carrying the operator's own cookies is the one confused deputy this surface has.
    const browser = await relay.call('PUT', `/v1/devices/${DEVICE_A}`, {
        json: { voip_token: TOKENS[DEVICE_A] },
        headers: { origin: 'https://example.test' },
    });
    assert.equal(browser.status, 403);
    assert.deepEqual(browser.data, { error: 'forbidden' });

    assert.equal(relay.devices.size, 0);
    assert.equal(relay.pushes.length, 0);

    // An installation an operator suspended is told so, distinctly from a credential that is
    // simply wrong: a suspension is the installation's own state, and an operator can lift it.
    const suspended = createMockRelay();
    suspended.setStatus(suspended.installationId, 'suspended');
    const refused = await suspended.call('PUT', `/v1/devices/${DEVICE_A}`, {
        json: { voip_token: TOKENS[DEVICE_A] },
    });
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.data, { error: 'suspended' });
});

test('a device that is not this installation\'s is the same answer as one that does not exist', async () => {
    const relay = await withDevices();
    const other = createMockRelay({ credentials: [{ credential: `cbr_${'y'.repeat(43)}`, installationId: 'ins_other' }] });

    const unknown = await push(relay, { device_id: 'dev_unknown000000' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.data, { error: 'not_found' });

    // The other installation's credential cannot see, push, or remove this installation's device:
    // `installation_id` is in every `WHERE` clause, so it is not a check a route can forget.
    const stolen = await other.call('POST', '/v1/push/voip', {
        json: {
            request_id: requestId(),
            device_id: DEVICE_A,
            call_id: CALL_ID,
            caller_id: CALLER_ID,
            caller_name: CALLER_NAME,
            has_video: false,
        },
    });
    assert.equal(stolen.status, 404);
    assert.equal((await other.call('DELETE', `/v1/devices/${DEVICE_A}`)).status, 404);
    assert.equal(relay.devices.size, 2);
    assert.equal(relay.pushes.length, 0);
});

test('the mock is the same relay behind a real port', async (t) => {
    const relay = createMockRelay();
    const { base, port } = await relay.listen(0);
    t.after(() => relay.close());
    assert.ok(port > 0);

    const health = await fetch(`${base}/v1/health`);
    assert.equal(health.status, 200);

    const registered = await fetch(`${base}/v1/devices/${DEVICE_A}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${relay.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ voip_token: TOKENS[DEVICE_A] }),
    });
    assert.equal(registered.status, 200);

    const pushed = await fetch(`${base}/v1/push/voip`, {
        method: 'POST',
        headers: { authorization: `Bearer ${relay.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            request_id: requestId(),
            device_id: DEVICE_A,
            call_id: CALL_ID,
            caller_id: CALLER_ID,
            caller_name: CALLER_NAME,
            has_video: false,
        }),
    });
    assert.equal(pushed.status, 200);
    assert.equal(relay.pushes.length, 1);

    const unauthenticated = await fetch(`${base}/v1/health`, { method: 'POST' });
    assert.equal(unauthenticated.status, 405);
});

// ---------------------------------------------------------------------------------------
// This server's own relay client, once it exists.
// ---------------------------------------------------------------------------------------

const CLIENT_FILE = 'src/pushrelay.js';
const SKIP_AWAITING_CLIENT = `awaits ${CLIENT_FILE} (the backend relay client)`;

let relayClient = null;
try {
    relayClient = require('../src/pushrelay');
} catch (error) {
    // A missing file is expected until the other worker lands it. Anything else — including that
    // file throwing on load — is a real failure and must not be hidden behind a skip.
    if (error.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes('pushrelay')) throw error;
}

const quiet = { warn() {}, info() {}, error() {} };

/** The client, wired to the mock: it is handed the `fetch` it must use, so no socket is needed. */
function backendClient(config = {}) {
    const relay = createMockRelay();
    const client = relayClient.createPushRelayClient({
        config: {
            pushRelayUrl: 'https://relay.test',
            pushRelayToken: relay.credential,
            pushRelayInstallationId: relay.installationId,
            pushRelayTimeoutMs: 2000,
            ...config,
        },
        log: quiet,
        fetch: (url, init) => relay.handle(new Request(url, init)),
    });
    return { relay, client };
}

const CALL = { callId: CALL_ID, callerId: CALLER_ID, callerName: CALLER_NAME, hasVideo: true };

test('the client registers a device and rings it with a payload the app can read', { skip: relayClient === null && SKIP_AWAITING_CLIENT }, async () => {
    const { relay, client } = backendClient();

    const registered = await client.registerDevice({ deviceId: DEVICE_A, token: TOKENS[DEVICE_A] });
    assert.equal(registered.ok, true);
    assert.equal(relay.devices.get(`${relay.installationId}\u0000${DEVICE_A}`).token, TOKENS[DEVICE_A]);
    // The credential travels in the header and nowhere else.
    assert.equal(relay.requests[0].headers.authorization, `Bearer ${relay.credential}`);
    assert.equal(relay.requests[0].url.includes(relay.credential), false);

    const outcome = await client.sendIncomingCall({ deviceId: DEVICE_A, requestId: requestId(), ...CALL });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.status, 200);
    assert.deepEqual(relay.pushes[0].payload.crossbar, {
        v: 1,
        type: 'incoming_call',
        installation_id: relay.installationId,
        call_id: CALL_ID,
        caller_id: CALLER_ID,
        caller_name: CALLER_NAME,
        has_video: true,
    });
});

test('the client derives one request_id per device, and keeps it across retries', { skip: relayClient === null && SKIP_AWAITING_CLIENT }, async () => {
    const { relay, client } = backendClient();
    await client.registerDevice({ deviceId: DEVICE_A, token: TOKENS[DEVICE_A] });
    await client.registerDevice({ deviceId: DEVICE_B, token: TOKENS[DEVICE_B] });

    const forA = client.requestIdFor(CALL_ID, DEVICE_A);
    const forB = client.requestIdFor(CALL_ID, DEVICE_B);
    assert.match(forA, UUID_PATTERN);
    assert.notEqual(forA, forB, 'one id for both devices would 409 on the second');
    assert.equal(client.requestIdFor(CALL_ID, DEVICE_A), forA, 'a retry of the same push reuses it');
    assert.notEqual(client.requestIdFor(crypto.randomUUID(), DEVICE_A), forA, 'a new call gets a new id');

    const first = await client.sendIncomingCall({ deviceId: DEVICE_A, requestId: forA, ...CALL });
    const second = await client.sendIncomingCall({ deviceId: DEVICE_B, requestId: forB, ...CALL });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(relay.pushes.map((sent) => sent.deviceId), [DEVICE_A, DEVICE_B]);
});

test('the client tells a gone device from a retryable fault', { skip: relayClient === null && SKIP_AWAITING_CLIENT }, async () => {
    const { relay, client } = backendClient();
    await client.registerDevice({ deviceId: DEVICE_A, token: TOKENS[DEVICE_A] });

    relay.answerWith(PUSH_OUTCOMES.transient);
    const transient = await client.sendIncomingCall({ deviceId: DEVICE_A, requestId: requestId(), ...CALL });
    assert.equal(transient.ok, false);
    assert.equal(transient.status, 503);
    assert.ok(transient.retryAfterSeconds > 0);
    assert.notEqual(transient.deviceGone, true);

    // A 410 is the one answer that means "forget this token": the relay has already stopped
    // pushing to it, so retrying the call is pointless and the row must be cleared.
    relay.answerWith({ kind: PUSH_OUTCOMES.device_invalid, reason: 'Unregistered' });
    const gone = await client.sendIncomingCall({ deviceId: DEVICE_A, requestId: requestId(), ...CALL });
    assert.equal(gone.status, 410);
    assert.equal(gone.deviceGone, true);
});

test('an unconfigured client refuses locally and sends nothing', { skip: relayClient === null && SKIP_AWAITING_CLIENT }, async () => {
    const { relay, client } = backendClient({ pushRelayUrl: '', pushRelayToken: '' });
    assert.equal(client.enabled, false);

    const refused = await client.sendIncomingCall({ deviceId: DEVICE_A, requestId: requestId(), ...CALL });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 0);
    assert.equal(refused.error, 'not_configured');
    assert.equal((await client.registerDevice({ deviceId: DEVICE_A, token: TOKENS[DEVICE_A] })).ok, false);
    assert.equal(relay.requests.length, 0, 'a deployment without a relay never calls one');
});
