'use strict';

// The push relay client, and the two places it is wired in.
//
// The relay is not reachable from a test — it would ring a real phone, and its credential
// does not exist here — so a stand-in one is used: a real HTTP server that records what it
// was asked and answers what the test tells it. That is also the only way to assert the
// parts whose failure is silent, which are the shape of the request (a field the relay
// refuses is a phone that never rings), the `request_id` (the same one across a retry is
// the difference between a retry and a second ring) and the credential (which must never
// appear anywhere but the `Authorization` header).
//
// Its own stub on purpose: `test/helpers/mock-relay*` belongs to the relay contract tests,
// and this file must not stop proving the client when that file changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const { createPushRelayClient, requestIdFor } = require('../src/pushrelay');
const { startTestServer, api, createCall } = require('./helpers');

/** A credential of the shape the relay issues: `cbr_` and 43 base64url characters. */
const TOKEN = `cbr_${'A'.repeat(43)}`;

const CALL_ID = 'b7a1c2d3-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const DEVICE_ID = 'dev_RhB3R7UuH9TqbmBJ';
const VOIP_TOKEN = 'ab'.repeat(32);

/**
 * A stand-in relay: a real HTTP server, one recorded request per call, answers in order.
 *
 * `answers` is a queue; anything past the end is a `200 {ok:true}`. `hang` never answers, so
 * the client's own deadline is what ends the request, and `destroy` drops the socket — the
 * two ways a real relay can leave a caller without an answer.
 */
async function startStubRelay(answers = []) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            requests.push({
                method: req.method,
                path: req.url,
                headers: req.headers,
                // Parsed rather than compared as text: what the relay validates is the body,
                // and key order is not part of it.
                body: raw ? JSON.parse(raw) : null,
            });
            const answer = answers.shift() || { status: 200, body: { ok: true } };
            if (answer.hang) return;
            if (answer.destroy) {
                req.socket.destroy();
                return;
            }
            res.writeHead(answer.status, {
                'content-type': 'application/json; charset=utf-8',
                ...(answer.retryAfter === undefined ? {} : { 'retry-after': String(answer.retryAfter) }),
            });
            res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        requests,
        url: `http://127.0.0.1:${server.address().port}`,
        async close() {
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

/** What the client logged, so a test can assert a secret is not in it. */
function captureLog() {
    const records = [];
    return {
        records,
        warn: (event, fields) => records.push({ event, fields }),
        info: () => {},
        error: () => {},
        debug: () => {},
    };
}

function clientFor(stub, overrides = {}) {
    const log = captureLog();
    const client = createPushRelayClient({
        config: {
            pushRelayUrl: stub.url,
            pushRelayToken: TOKEN,
            pushRelayInstallationId: 'ins_test',
            pushRelayTimeoutMs: 1000,
            ...overrides,
        },
        log,
    });
    return { client, log };
}

/** Up to two seconds for something the server does with `void …catch(…)`. */
async function settle(check) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return check();
}

test('a ring carries exactly the six scalars the relay accepts, and no more', async (t) => {
    const stub = await startStubRelay([{ status: 200, body: { ok: true, status: 'accepted', apns_id: CALL_ID } }]);
    t.after(() => stub.close());
    const { client } = clientFor(stub);

    const outcome = await client.sendIncomingCall({
        deviceId: DEVICE_ID,
        requestId: crypto.randomUUID(),
        callId: CALL_ID,
        callerId: 'abdullah',
        callerName: 'Abdullah',
        hasVideo: true,
    });

    assert.equal(outcome.ok, true);
    const [request] = stub.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v1/push/voip');
    // Exactly `application/json`: the relay refuses a `charset` parameter with a 415.
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    // A field the relay does not know is refused rather than ignored, so the body is the
    // whole contract: six keys, at the top level, and nothing beside them.
    assert.deepEqual(Object.keys(request.body).sort(), [
        'call_id', 'caller_id', 'caller_name', 'device_id', 'has_video', 'request_id',
    ]);
    assert.equal(request.body.device_id, DEVICE_ID);
    assert.equal(request.body.call_id, CALL_ID);
    assert.equal(request.body.has_video, true, 'strictly a boolean; "true" is refused');
});

test('a display name is clipped to the wire bound rather than costing the ring', async (t) => {
    const stub = await startStubRelay();
    t.after(() => stub.close());
    const { client } = clientFor(stub);

    await client.sendIncomingCall({
        deviceId: DEVICE_ID,
        requestId: crypto.randomUUID(),
        callId: CALL_ID,
        callerId: 'abdullah',
        // Longer than the relay's 64 code units, and carrying a character a lock screen
        // cannot draw. Either one alone is a 400, which is a phone that never rings.
        callerName: `Amina ${'Y'.repeat(80)}\nYusuf`,
        hasVideo: false,
    });

    const [request] = stub.requests;
    assert.equal(request.body.caller_name.length, 64);
    assert.doesNotMatch(request.body.caller_name, /\n/);
    assert.match(request.body.caller_name, /^Amina Y+/);
});

test('one request_id per device, derived so a retry reuses it', () => {
    const other = 'dev_jo66Y10591oq3rhw';

    const first = requestIdFor(CALL_ID, DEVICE_ID);
    // The property the relay's duplicate suppression is for: a retry of the same push to the
    // same device carries the same id, and this is why nothing has to be stored to know it.
    assert.equal(requestIdFor(CALL_ID, DEVICE_ID), first);
    // One id per device, because the relay keys on (installation_id, request_id): a fan-out
    // sharing one id is refused with a 409 for the second phone.
    assert.notEqual(requestIdFor(CALL_ID, other), first);
    // And per call: a new call is a new push, not a replay of an old one.
    assert.notEqual(requestIdFor('3f2504e0-4f89-41d3-9a0c-0305e82c3301', DEVICE_ID), first);
    // The relay accepts a canonical UUID and folds case; APNs is handed this as `apns-id`.
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('a registration is a PUT at the device address, and a rotation updates it', async (t) => {
    const stub = await startStubRelay([
        { status: 200, body: { ok: true, device_id: DEVICE_ID, registered: true } },
        { status: 200, body: { ok: true, device_id: DEVICE_ID, registered: true } },
    ]);
    t.after(() => stub.close());
    const { client } = clientFor(stub);

    assert.equal((await client.registerDevice({ deviceId: DEVICE_ID, token: VOIP_TOKEN })).ok, true);
    const rotated = `${VOIP_TOKEN.slice(0, -2)}cd`;
    assert.equal((await client.registerDevice({ deviceId: DEVICE_ID, token: rotated })).ok, true);

    const [first, second] = stub.requests;
    assert.equal(first.method, 'PUT');
    assert.equal(first.path, `/v1/devices/${DEVICE_ID}`, 'the backend device id is the relay device id');
    assert.equal(first.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(first.body, { voip_token: VOIP_TOKEN });
    // A rotated token is an upsert at the same address, not a second device: the relay's
    // device row is keyed by (installation, device_id), and a new id per rotation would leak
    // a row per token.
    assert.equal(second.path, first.path);
    assert.deepEqual(second.body, { voip_token: rotated });
});

test('a removal is a DELETE at the same address and reads no credential from a body', async (t) => {
    const stub = await startStubRelay([{ status: 200, body: { ok: true, device_id: DEVICE_ID, removed: true } }]);
    t.after(() => stub.close());
    const { client } = clientFor(stub);

    const outcome = await client.removeDevice({ deviceId: DEVICE_ID });

    assert.equal(outcome.ok, true);
    const [request] = stub.requests;
    assert.equal(request.method, 'DELETE');
    assert.equal(request.path, `/v1/devices/${DEVICE_ID}`);
    assert.equal(request.body, null);
});

test('the refusals the relay names are decoded, and only the temporary ones are retryable', async (t) => {
    const stub = await startStubRelay([
        { status: 409, body: { error: 'token_conflict' } },
        { status: 429, body: { error: 'rate_limited' }, retryAfter: 30 },
        { status: 503, body: { error: 'apns_unavailable' }, retryAfter: 12 },
        { status: 409, body: { error: 'request_in_progress' }, retryAfter: 5 },
        { status: 410, body: { error: 'device_unregistered' } },
        { status: 500, body: 'not json at all' },
    ]);
    t.after(() => stub.close());
    const { client } = clientFor(stub);

    // A token another device already owns: nothing was written, and no retry changes that.
    const conflict = await client.registerDevice({ deviceId: DEVICE_ID, token: VOIP_TOKEN });
    assert.deepEqual(
        [conflict.ok, conflict.status, conflict.error, conflict.permanent, conflict.retryAfterSeconds],
        [false, 409, 'token_conflict', true, null],
    );

    const limited = await client.sendIncomingCall({
        deviceId: DEVICE_ID, requestId: crypto.randomUUID(), callId: CALL_ID, callerId: 'a', callerName: 'A', hasVideo: false,
    });
    assert.deepEqual(
        [limited.ok, limited.error, limited.permanent, limited.retryAfterSeconds],
        [false, 'rate_limited', false, 30],
        '429 is temporary and says how long for',
    );

    const unavailable = await client.sendIncomingCall({
        deviceId: DEVICE_ID, requestId: crypto.randomUUID(), callId: CALL_ID, callerId: 'a', callerName: 'A', hasVideo: false,
    });
    assert.deepEqual([unavailable.error, unavailable.permanent, unavailable.retryAfterSeconds], ['apns_unavailable', false, 12]);

    const busy = await client.sendIncomingCall({
        deviceId: DEVICE_ID, requestId: crypto.randomUUID(), callId: CALL_ID, callerId: 'a', callerName: 'A', hasVideo: false,
    });
    assert.equal(busy.permanent, false, 'another attempt holds the claim; ask again with the same request_id');

    // The one refusal that proves the token is dead, which is what the caller acts on.
    const gone = await client.sendIncomingCall({
        deviceId: DEVICE_ID, requestId: crypto.randomUUID(), callId: CALL_ID, callerId: 'a', callerName: 'A', hasVideo: false,
    });
    assert.deepEqual([gone.deviceGone, gone.permanent, gone.error], [true, true, 'device_unregistered']);

    // A 500 whose body is not the relay's shape is still a refusal, and the status is the
    // part that is always there.
    const faulted = await client.registerDevice({ deviceId: DEVICE_ID, token: VOIP_TOKEN });
    assert.deepEqual([faulted.ok, faulted.status, faulted.error, faulted.permanent], [false, 500, 'unknown_error', true]);
});

test('a timeout and a refused connection are unknown, not failures, so a retry is safe', async (t) => {
    const hanging = await startStubRelay([{ hang: true }]);
    const dropped = await startStubRelay([{ destroy: true }]);
    t.after(() => Promise.all([hanging.close(), dropped.close()]));
    const { client: slow } = clientFor(hanging, { pushRelayTimeoutMs: 300 });
    const { client: cut } = clientFor(dropped);

    const started = Date.now();
    const timedOut = await slow.healthCheck();
    const elapsed = Date.now() - started;
    const refused = await cut.healthCheck();

    assert.equal(hanging.requests.length, 1, 'the request did go out; it is the answer that never came');
    assert.deepEqual([timedOut.ok, timedOut.status, timedOut.error, timedOut.permanent], [false, 0, 'unreachable', false]);
    assert.deepEqual([refused.error, refused.permanent], ['unreachable', false]);
    // Bounded: the deadline is what ends it, and the deadline is the configuration's.
    assert.ok(elapsed < 2000, `a request with a 300ms deadline returned in ${elapsed}ms`);
});

test('the credential is never written to a log line', async (t) => {
    const stub = await startStubRelay([{ status: 409, body: { error: 'token_conflict' } }, { hang: true }]);
    t.after(() => stub.close());
    const { client, log } = clientFor(stub, { pushRelayTimeoutMs: 300 });

    // Both paths that log: a refusal from the relay, and a request that never got an answer.
    await client.registerDevice({ deviceId: DEVICE_ID, token: VOIP_TOKEN });
    await client.healthCheck();

    assert.ok(log.records.length >= 2, 'both failures were said out loud');
    const written = JSON.stringify(log.records);
    assert.doesNotMatch(written, /cbr_/, 'the credential is not a log field');
    assert.doesNotMatch(written, /Bearer/, 'nor is the header it travels in');
    assert.doesNotMatch(written, new RegExp(VOIP_TOKEN), 'nor is the PushKit token');
    assert.doesNotMatch(written, /ab{8}/, 'nor any part of it');
    // What is logged is the part an operator acts on.
    assert.equal(log.records[0].event, 'push_relay_refused');
    assert.equal(log.records[0].fields.status, 409);
    assert.equal(log.records[0].fields.error, 'token_conflict');
    assert.equal(log.records[0].fields.installation, 'ins_test');
});

test('without a relay the client refuses locally and sends nothing', async (t) => {
    const stub = await startStubRelay();
    t.after(() => stub.close());
    const { client } = clientFor(stub, { pushRelayUrl: '', pushRelayToken: '' });

    assert.equal(client.enabled, false);
    const outcome = await client.sendIncomingCall({
        deviceId: DEVICE_ID, requestId: crypto.randomUUID(), callId: CALL_ID, callerId: 'a', callerName: 'A', hasVideo: false,
    });
    assert.deepEqual([outcome.status, outcome.error], [0, 'not_configured']);
    assert.equal(stub.requests.length, 0);
});

test('a token or a device id the relay would refuse is refused here instead', async (t) => {
    const stub = await startStubRelay();
    t.after(() => stub.close());
    const { client } = clientFor(stub);

    // An empty token is what a client that sent no `kind` looks like; the relay answers a
    // 400, and a 400 per token rotation is noise in an operator's log for a request that was
    // never going to be accepted.
    assert.equal((await client.registerDevice({ deviceId: DEVICE_ID, token: '' })).error, 'invalid_token');
    assert.equal((await client.registerDevice({ deviceId: DEVICE_ID, token: 'zzzz' })).error, 'invalid_token');
    assert.equal((await client.registerDevice({ deviceId: 'dev_a', token: VOIP_TOKEN })).error, 'invalid_device_id');
    assert.equal((await client.removeDevice({ deviceId: '../../etc/passwd' })).error, 'invalid_device_id');
    assert.equal(stub.requests.length, 0, 'nothing was sent to be refused');
});

test('the health check reads no credential, because the relay reads none', async (t) => {
    const stub = await startStubRelay([{
        status: 200,
        body: { ok: true, service: 'crossbar-push-relay', version: '0.1.0', environment: 'development' },
    }]);
    t.after(() => stub.close());
    const { client } = clientFor(stub);

    const outcome = await client.healthCheck();

    assert.equal(outcome.ok, true);
    assert.equal(outcome.body.environment, 'development');
    const [request] = stub.requests;
    assert.equal(request.method, 'GET');
    assert.equal(request.path, '/v1/health');
    assert.equal(request.headers.authorization, undefined, 'a secret is not sent where nothing reads one');
});

test('a VoIP token presented to the API is registered with the relay at the same device id', async (t) => {
    const stub = await startStubRelay([{ status: 200, body: { ok: true, registered: true } }]);
    t.after(() => stub.close());
    const { server, base } = await startTestServer({
        pushRelayUrl: stub.url,
        pushRelayToken: TOKEN,
        pushRelayInstallationId: 'ins_test',
        pushRelayTimeoutMs: 2000,
    });
    t.after(() => server.close());

    await api(base, 'dad@dev', '/api/devices', {
        method: 'POST',
        body: { deviceId: DEVICE_ID, label: 'Dad', platform: 'ios' },
    });
    const saved = await api(base, 'dad@dev', '/api/devices/push-token', {
        method: 'POST',
        body: { deviceId: DEVICE_ID, token: VOIP_TOKEN, environment: 'sandbox', kind: 'voip' },
    });

    assert.equal(saved.status, 200);
    assert.equal(saved.data.saved, true, 'the row is this server’s, whatever the relay answers');
    assert.deepEqual(saved.data.relay, {
        configured: true, ok: true, outcome: 'saved', status: 200, error: null, retryAfterSeconds: null,
    });
    const [registration] = stub.requests;
    assert.equal(registration.method, 'PUT');
    assert.equal(registration.path, `/v1/devices/${DEVICE_ID}`);
    assert.deepEqual(registration.body, { voip_token: VOIP_TOKEN });
});

test('an incoming call wakes the phone through the relay, not through this server’s APNs', async (t) => {
    const stub = await startStubRelay([
        { status: 200, body: { ok: true, registered: true } },
        { status: 200, body: { ok: true, status: 'accepted' } },
    ]);
    t.after(() => stub.close());
    const { server, base } = await startTestServer({
        pushRelayUrl: stub.url,
        pushRelayToken: TOKEN,
        pushRelayInstallationId: 'ins_test',
        pushRelayTimeoutMs: 2000,
    });
    t.after(() => server.close());

    await api(base, 'dad@dev', '/api/devices', {
        method: 'POST',
        body: { deviceId: DEVICE_ID, label: 'Dad', platform: 'ios' },
    });
    await api(base, 'dad@dev', '/api/devices/push-token', {
        method: 'POST',
        body: { deviceId: DEVICE_ID, token: VOIP_TOKEN, environment: 'sandbox', kind: 'voip' },
    });

    const created = await createCall(base, 'abdullah@dev', ['dad']);
    assert.ok(await settle(() => stub.requests.length >= 2), 'the ring is fire-and-forget, so wait for it');

    const ring = stub.requests[1];
    assert.equal(ring.method, 'POST');
    assert.equal(ring.path, '/v1/push/voip');
    // The call id is the backend's, which is the CallKit UUID the app already knows, so the
    // push and the realtime event deduplicate exactly.
    assert.equal(ring.body.call_id, created.call.id);
    assert.equal(ring.body.device_id, DEVICE_ID);
    assert.equal(ring.body.caller_id, 'abdullah');
    assert.equal(ring.body.caller_name, 'Abdullah');
    assert.equal(ring.body.has_video, true, 'a call with no kind is a video call');
    // Derivable rather than stored: the retry of this same ring carries this same id.
    assert.equal(ring.body.request_id, requestIdFor(created.call.id, DEVICE_ID));
});

test('a phone whose token the relay says is gone has it cleared, and the call does not care', async (t) => {
    const stub = await startStubRelay([
        { status: 200, body: { ok: true, registered: true } },
        { status: 410, body: { error: 'device_unregistered' } },
    ]);
    t.after(() => stub.close());
    const { server, base } = await startTestServer({
        pushRelayUrl: stub.url,
        pushRelayToken: TOKEN,
        pushRelayInstallationId: 'ins_test',
        pushRelayTimeoutMs: 2000,
    });
    t.after(() => server.close());

    await api(base, 'dad@dev', '/api/devices', {
        method: 'POST',
        body: { deviceId: DEVICE_ID, label: 'Dad', platform: 'ios' },
    });
    await api(base, 'dad@dev', '/api/devices/push-token', {
        method: 'POST',
        body: { deviceId: DEVICE_ID, token: VOIP_TOKEN, environment: 'production', kind: 'voip' },
    });
    assert.equal(server.store.voipTokensFor(['dad']).length, 1);

    const created = await createCall(base, 'abdullah@dev', ['dad']);

    assert.ok(await settle(() => server.store.voipTokensFor(['dad']).length === 0),
        'a dead token is cleared rather than tried for ever, as APNs’ own 410 was');
    // And the call is untouched: the ring is a doorbell, and a doorbell that fails does not
    // end a call.
    assert.equal(server.store.callById(created.call.id).status, 'ringing');
});

test('a phone that cannot be reached yet is reported, not raised', async (t) => {
    const stub = await startStubRelay([{ status: 409, body: { error: 'token_conflict' } }]);
    t.after(() => stub.close());
    const { server, base } = await startTestServer({
        pushRelayUrl: stub.url,
        pushRelayToken: TOKEN,
        pushRelayInstallationId: 'ins_test',
        pushRelayTimeoutMs: 2000,
    });
    t.after(() => server.close());

    await api(base, 'dad@dev', '/api/devices', {
        method: 'POST',
        body: { deviceId: DEVICE_ID, label: 'Dad', platform: 'ios' },
    });
    const saved = await api(base, 'dad@dev', '/api/devices/push-token', {
        method: 'POST',
        body: { deviceId: DEVICE_ID, token: VOIP_TOKEN, environment: 'production', kind: 'voip' },
    });

    // The token belongs to another server and no retry changes that, so the app is told what
    // happened — `permanent` — rather than being given an error it would retry: "this phone
    // could not be enabled yet" is a sentence, not a bug (relay docs/BACKEND_INTEGRATION.md, 409).
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.relay, {
        configured: true, ok: false, outcome: 'permanent', status: 409,
        error: 'token_conflict', retryAfterSeconds: null,
    });
    assert.equal(server.store.voipTokensFor(['dad']).length, 1, 'this server remembers where the phone is');
});
