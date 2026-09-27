'use strict';

// Device ownership and registration, from the routes that change a row or ring a phone.
//
// Three things are pinned here, all of them about a device id being the one field a client
// gets to choose:
//
//   * an id already held by somebody else is not a claim on their row. The upsert used to
//     reassign `user_id`, so naming an id was enough to take its push token, its VoIP token
//     and its public key (SEC-RELAY-01) — the ownership check on the registration route
//     cannot mean anything while that is true;
//   * a revoked device does not re-register, because the relay's upsert would set it active
//     again and undo the revocation (SEC-RELAY-02);
//   * the relay's answer is part of what these routes reply, and a refusal that a retry can
//     fix is told apart from one it cannot (SEC-RELAY-07, REL-RELAY-01). `saved: true` alone
//     used to be the whole answer, and the app cleared its held token on it — so a
//     registration that arrived during a relay timeout left the phone unringable for good.
//
// The relay is a stand-in on a real port, the same way `test/pushrelay.test.js` does it: the
// answers that matter here are the ones a real relay cannot be asked for on demand.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

const { startTestServer, api } = require('./helpers');

/** A credential of the shape the relay issues, and the device ids the client mints. */
const TOKEN = `cbr_${'A'.repeat(43)}`;
const DEVICE_A = 'dev_RhB3R7UuH9TqbmBJ';
const DEVICE_B = 'dev_jo66Y10591oq3rhw';
const VOIP_TOKEN = 'ab'.repeat(32);
const OTHER_TOKEN = 'cd'.repeat(32);

/**
 * A stand-in relay: a real HTTP server, one recorded request per call, answers in order.
 *
 * `answers` is a queue; anything past the end is a `200 {ok:true}`. A relay that never answers
 * at all is `UNREACHABLE_RELAY` below, which is a real refused connection rather than a stub
 * that behaves badly.
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
                path: new URL(req.url, 'http://relay.test').pathname,
                headers: req.headers,
                body: raw ? JSON.parse(raw) : null,
            });
            const answer = answers.shift() || { status: 200, body: { ok: true } };
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

/** A relay with nothing listening on its port, so every request is a refused connection. */
const UNREACHABLE_RELAY = 'http://127.0.0.1:1';

function withRelay(stub, overrides = {}) {
    return {
        pushRelayUrl: stub.url,
        pushRelayToken: TOKEN,
        pushRelayInstallationId: 'ins_test',
        pushRelayTimeoutMs: 2000,
        ...overrides,
    };
}

async function registerDevice(base, who, deviceId, label = who) {
    return api(base, who, '/api/devices', { method: 'POST', body: { deviceId, label, platform: 'ios' } });
}

async function uploadVoipToken(base, who, deviceId, token = VOIP_TOKEN) {
    return api(base, who, '/api/devices/push-token', {
        method: 'POST',
        body: { deviceId, token, environment: 'production', kind: 'voip' },
    });
}

// ── Device sessions, for the route only a device itself may call ────────────────────────

const SIGNED_PREFIX = 'crossbar-device-auth-v1';
/** Device authentication available, which is what a session needs to exist at all. */
const AUTH_AVAILABLE = { sessionSecret: 'test-session-secret' };

function newDeviceKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        sign: (payload) => crypto.sign('sha256', payload, privateKey).toString('base64'),
    };
}

function bearer(token) {
    return { authorization: `Bearer ${token}` };
}

/**
 * A device that arrived the ordinary way — invited, enrolled, and then signed in by answering
 * a challenge — so its session (not a header somebody typed) is what names it.
 */
async function signedInDevice(base, userId) {
    const invitation = await api(base, 'abdullah@dev', '/api/admin/enrollments', {
        method: 'POST',
        body: { userId },
    });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.data));
    const key = newDeviceKey();
    const enrolled = await api(base, null, '/api/auth/enroll', {
        method: 'POST',
        body: {
            token: invitation.data.payload.enrollment_token,
            publicKey: key.publicKey,
            algorithm: 'ES256',
            deviceName: 'Test iPhone',
            platform: 'ios',
        },
    });
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.data));
    const deviceId = enrolled.data.device.id;

    const challenge = await api(base, null, '/api/auth/challenge', { method: 'POST', body: { deviceId } });
    assert.equal(challenge.status, 200, JSON.stringify(challenge.data));
    const signature = key.sign(Buffer.from(
        `${SIGNED_PREFIX}\n${deviceId}\n${challenge.data.challengeId}\n${challenge.data.nonce}`, 'utf8'));
    const session = await api(base, null, '/api/auth/session', {
        method: 'POST',
        body: { deviceId, challengeId: challenge.data.challengeId, signature },
    });
    assert.equal(session.status, 200, JSON.stringify(session.data));
    return { deviceId, token: session.data.session.token };
}

// ── SEC-RELAY-01: an id is not a claim on somebody else's row ───────────────────────────

test('a device cannot be taken over by naming another person\'s device id', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    assert.equal((await registerDevice(base, 'abdullah@dev', DEVICE_A, 'Abdullah')).status, 201);
    await uploadVoipToken(base, 'abdullah@dev', DEVICE_A);
    assert.equal(server.store.voipTokensFor(['abdullah']).length, 1, 'the phone is ringable at its owner');

    const taken = await registerDevice(base, 'dad@dev', DEVICE_A, 'Dad');
    assert.equal(taken.status, 409);
    assert.equal(taken.data.error.code, 'DEVICE_OWNED');

    // The row, and everything on it, is exactly as its owner left it.
    const row = server.store.deviceIdentity(DEVICE_A);
    assert.equal(row.userId, 'abdullah');
    assert.equal(row.label, 'Abdullah');
    assert.equal(server.store.voipTokensFor(['dad']).length, 0, 'dad cannot ring a phone that is not his');
    assert.equal(server.store.voipTokensFor(['abdullah']).length, 1);
});

test('a person registering their own device again is an update, not a refusal', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    assert.equal((await registerDevice(base, 'dad@dev', DEVICE_B, 'Dad')).status, 201);
    // The same id, the same person: this is how a device re-registers after a reinstall, and
    // the guard must not turn it into a conflict.
    const again = await registerDevice(base, 'dad@dev', DEVICE_B, 'Dad’s iPhone');
    assert.equal(again.status, 201);
    assert.equal(again.data.device.id, DEVICE_B);
    assert.equal(server.store.deviceIdentity(DEVICE_B).label, 'Dad’s iPhone');
    assert.equal(server.store.allDevices('dad').length, 1, 'still one row, not two');
});

// ── SEC-RELAY-02: a revoked device stays revoked ────────────────────────────────────────

test('a revoked device cannot register a token again', async (t) => {
    const stub = await startStubRelay();
    const { server, base } = await startTestServer(withRelay(stub));
    t.after(() => Promise.all([stub.close(), server.close()]));

    await registerDevice(base, 'dad@dev', DEVICE_A, 'Dad');
    server.store.revokeDevice(DEVICE_A, new Date().toISOString());

    // Re-registering the id does not bring it back: that is an update to a row this person
    // already holds, and it leaves the status alone — reactivating a device is what enrolling
    // it again does, with a new key.
    const again = await registerDevice(base, 'dad@dev', DEVICE_A, 'Dad');
    assert.equal(again.status, 201);
    assert.equal(server.store.deviceIdentity(DEVICE_A).status, 'revoked');

    const refused = await uploadVoipToken(base, 'dad@dev', DEVICE_A);
    assert.equal(refused.status, 409);
    assert.equal(refused.data.error.code, 'DEVICE_REVOKED');
    // Which state, not just "not allowed": the operator's action is named back.
    assert.match(refused.data.error.message, /revoked/);
    assert.equal(server.store.voipTokensFor(['dad']).length, 0, 'nothing was stored for it');
    assert.equal(stub.requests.length, 0, 'and the relay was never asked to reactivate it');
});

// ── SEC-RELAY-07 + REL-RELAY-01: the relay's answer is part of the reply ────────────────

test('a registration the relay accepted answers saved, and reaches it at the device id', async (t) => {
    const stub = await startStubRelay([{ status: 200, body: { ok: true, registered: true } }]);
    const { server, base } = await startTestServer(withRelay(stub));
    t.after(() => Promise.all([stub.close(), server.close()]));

    await registerDevice(base, 'dad@dev', DEVICE_A, 'Dad');
    const saved = await uploadVoipToken(base, 'dad@dev', DEVICE_A);

    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.relay, {
        configured: true, ok: true, outcome: 'saved', status: 200, error: null, retryAfterSeconds: null,
    });
    const [registration] = stub.requests;
    assert.equal(registration.method, 'PUT');
    assert.equal(registration.path, `/v1/devices/${DEVICE_A}`);
    assert.deepEqual(registration.body, { voip_token: VOIP_TOKEN });
});

test('a relay refusal the phone can retry is answered as retryable, and the row still says saved', async (t) => {
    // 429 is the relay's own allowance being spent, and it says how long for. The same upload
    // sent again later is the whole fix, which is why the app must not clear its token.
    const stub = await startStubRelay([{ status: 429, body: { error: 'rate_limited' }, retryAfter: 30 }]);
    const { server, base } = await startTestServer(withRelay(stub));
    t.after(() => Promise.all([stub.close(), server.close()]));

    await registerDevice(base, 'dad@dev', DEVICE_A, 'Dad');
    const saved = await uploadVoipToken(base, 'dad@dev', DEVICE_A);

    assert.equal(saved.status, 200);
    assert.equal(saved.data.saved, true, 'the row is this server’s, whatever the relay answers');
    assert.deepEqual(saved.data.relay, {
        configured: true, ok: false, outcome: 'retryable', status: 429,
        error: 'rate_limited', retryAfterSeconds: 30,
    });
    assert.equal(server.store.voipTokensFor(['dad']).length, 1, 'the token is kept: the phone is retrying');
});

test('a fault of the relay\'s own is retryable, not the phone\'s problem to solve', async (t) => {
    // A 5xx is the one case where "give up" and "try again" differ between a ring and a
    // registration: the relay is broken, and the phone uploading its token again is the whole
    // of the fix.
    const stub = await startStubRelay([{ status: 503, body: 'not json at all' }]);
    const { server, base } = await startTestServer(withRelay(stub));
    t.after(() => Promise.all([stub.close(), server.close()]));

    await registerDevice(base, 'dad@dev', DEVICE_A, 'Dad');
    const saved = await uploadVoipToken(base, 'dad@dev', DEVICE_A);

    assert.deepEqual(saved.data.relay, {
        configured: true, ok: false, outcome: 'retryable', status: 503,
        error: 'unknown_error', retryAfterSeconds: null,
    });
});

test('a token another installation owns is answered as permanent, because no retry frees it', async (t) => {
    const stub = await startStubRelay([{ status: 409, body: { error: 'token_conflict' } }]);
    const { server, base } = await startTestServer(withRelay(stub));
    t.after(() => Promise.all([stub.close(), server.close()]));

    await registerDevice(base, 'dad@dev', DEVICE_A, 'Dad');
    const saved = await uploadVoipToken(base, 'dad@dev', DEVICE_A);

    assert.equal(saved.data.saved, true);
    assert.deepEqual(saved.data.relay, {
        configured: true, ok: false, outcome: 'permanent', status: 409,
        error: 'token_conflict', retryAfterSeconds: null,
    });
});

test('a relay that never answers is retryable, and a deployment without one is too', async (t) => {
    const dropped = await startTestServer({
        pushRelayUrl: UNREACHABLE_RELAY,
        pushRelayToken: TOKEN,
        pushRelayInstallationId: 'ins_test',
        pushRelayTimeoutMs: 500,
    });
    const bare = await startTestServer();
    t.after(() => Promise.all([dropped.server.close(), bare.server.close()]));

    await registerDevice(dropped.base, 'dad@dev', DEVICE_A, 'Dad');
    const unreachable = await uploadVoipToken(dropped.base, 'dad@dev', DEVICE_A);
    assert.deepEqual(unreachable.data.relay, {
        configured: true, ok: false, outcome: 'retryable', status: 0,
        error: 'unreachable', retryAfterSeconds: null,
    });

    // No relay is not a refusal: a setting an operator can add later is exactly what a retry
    // is for, so the phone keeps its token rather than concluding it can never be rung.
    await registerDevice(bare.base, 'dad@dev', DEVICE_A, 'Dad');
    const unconfigured = await uploadVoipToken(bare.base, 'dad@dev', DEVICE_A);
    assert.deepEqual(unconfigured.data.relay, {
        configured: false, ok: false, outcome: 'retryable', status: 0,
        error: 'not_configured', retryAfterSeconds: null,
    });
    assert.equal(bare.server.store.voipTokensFor(['dad']).length, 1);
});

// ── The route a device calls for itself ─────────────────────────────────────────────────

test('a device releases itself, and only itself', async (t) => {
    const stub = await startStubRelay();
    const { server, base } = await startTestServer({ ...AUTH_AVAILABLE, ...withRelay(stub) });
    t.after(() => Promise.all([stub.close(), server.close()]));

    const mine = await signedInDevice(base, 'abdullah');
    const theirs = await signedInDevice(base, 'dad');
    stub.requests.length = 0;

    // Another person's phone: refused, and left working.
    const somebodyElses = await api(base, null, `/api/devices/${theirs.deviceId}`, {
        method: 'DELETE', headers: bearer(mine.token),
    });
    assert.equal(somebodyElses.status, 403);
    assert.equal(somebodyElses.data.error.code, 'DEVICE_NOT_YOURS');
    assert.equal(server.store.deviceIdentity(theirs.deviceId).status, 'active');
    assert.equal(stub.requests.length, 0, 'their registration was not touched');

    // An identity without a device session is not a device, so it has no self to release.
    const headerOnly = await api(base, 'abdullah@dev', `/api/devices/${mine.deviceId}`, { method: 'DELETE' });
    assert.equal(headerOnly.status, 403);
    assert.equal(server.store.deviceIdentity(mine.deviceId).status, 'active');

    const released = await api(base, null, `/api/devices/${mine.deviceId}`, {
        method: 'DELETE', headers: bearer(mine.token),
    });
    assert.equal(released.status, 200);
    assert.equal(released.data.removed, true);
    assert.deepEqual(released.data.relay, {
        configured: true, ok: true, outcome: 'removed', status: 200, error: null, retryAfterSeconds: null,
    });
    // Revoked, not erased: the key stops working and the record of the device stays.
    assert.equal(server.store.deviceIdentity(mine.deviceId).status, 'revoked');
    const [removal] = stub.requests;
    assert.equal(removal.method, 'DELETE');
    assert.equal(removal.path, `/v1/devices/${mine.deviceId}`);
    // And the session it released with is dead, so the release cannot be driven twice.
    assert.equal((await api(base, null, '/api/bootstrap', { headers: bearer(mine.token) })).status, 401);
});

test('the release reports a device the relay does not have, and a relay that refused', async (t) => {
    // The relay answers in order: the first release is refused, the second finds nothing.
    const stub = await startStubRelay([
        { status: 429, body: { error: 'rate_limited' }, retryAfter: 20 },
        { status: 404, body: { error: 'not_found' } },
    ]);
    const { server, base } = await startTestServer({ ...AUTH_AVAILABLE, ...withRelay(stub) });
    t.after(() => Promise.all([stub.close(), server.close()]));

    const refused = await signedInDevice(base, 'abdullah');
    const alreadyGone = await signedInDevice(base, 'dad');

    const limited = await api(base, null, `/api/devices/${refused.deviceId}`, {
        method: 'DELETE', headers: bearer(refused.token),
    });
    assert.equal(limited.status, 200);
    assert.deepEqual(limited.data.relay, {
        configured: true, ok: false, outcome: 'retryable', status: 429,
        error: 'rate_limited', retryAfterSeconds: 20,
    });
    assert.equal(server.store.deviceIdentity(refused.deviceId).status, 'revoked',
        'the local revocation is the fact, whatever the relay answered');

    const gone = await api(base, null, `/api/devices/${alreadyGone.deviceId}`, {
        method: 'DELETE', headers: bearer(alreadyGone.token),
    });
    // A `404` is the end state reached: the relay does not hold it, which is all this asked
    // for. The relay's own code is still reported so it is visible rather than assumed.
    assert.deepEqual(gone.data.relay, {
        configured: true, ok: true, outcome: 'removed', status: 404,
        error: 'not_found', retryAfterSeconds: null,
    });
});

// ── The console's own device routes, which reach the relay too ──────────────────────────

test('the console is told what the relay answered, not just that the row changed', async (t) => {
    const stub = await startStubRelay([
        { status: 429, body: { error: 'rate_limited' }, retryAfter: 20 },
        { status: 404, body: { error: 'not_found' } },
    ]);
    const { server, base } = await startTestServer(withRelay(stub));
    t.after(() => Promise.all([stub.close(), server.close()]));

    await registerDevice(base, 'dad@dev', DEVICE_A, 'Dad');

    const revoked = await api(base, 'abdullah@dev', `/api/admin/devices/${DEVICE_A}/revoke`, { method: 'POST' });
    assert.equal(revoked.status, 200);
    assert.equal(server.store.deviceIdentity(DEVICE_A).status, 'revoked');
    assert.deepEqual(revoked.data.relay, {
        configured: true, ok: false, outcome: 'retryable', status: 429,
        error: 'rate_limited', retryAfterSeconds: 20,
    });

    const removed = await api(base, 'abdullah@dev', `/api/admin/devices/${DEVICE_A}/remove`, { method: 'POST' });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.removed, true);
    assert.deepEqual(removed.data.relay, {
        configured: true, ok: true, outcome: 'removed', status: 404,
        error: 'not_found', retryAfterSeconds: null,
    });
});

// ── The limiter ─────────────────────────────────────────────────────────────────────────

test('the token route refuses a burst, so a loop here cannot hammer the relay', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    await registerDevice(base, 'dad@dev', DEVICE_A, 'Dad');
    const statuses = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
        const body = { deviceId: DEVICE_A, token: attempt % 2 ? OTHER_TOKEN : VOIP_TOKEN, environment: 'production' };
        statuses.push((await api(base, 'dad@dev', '/api/devices/push-token', { method: 'POST', body })).status);
    }

    assert.equal(statuses.filter((status) => status === 200).length, 10,
        'the allowance is what a phone uses in a minute, and it is spent in order');
    const last = await api(base, 'dad@dev', '/api/devices/push-token', {
        method: 'POST', body: { deviceId: DEVICE_A, token: VOIP_TOKEN, environment: 'production' },
    });
    assert.equal(last.status, 429);
    assert.equal(last.data.error.code, 'RATE_LIMITED');
});
