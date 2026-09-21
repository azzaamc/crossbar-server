'use strict';

// Device identity: enrolment, challenge-response, sessions, revocation, and the rules
// that only hold if the server checks them every time rather than once.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const auth = require('../src/auth');
const { startTestServer, api } = require('./helpers');

/**
 * The exact bytes a device signs.
 *
 * Spelled out here rather than imported, so this file states the contract instead of
 * agreeing with whatever the implementation happens to do.
 */
const SIGNED_PREFIX = 'crossbar-device-auth-v1';

/** Device authentication available, but not yet demanded: the state a private deployment moves through. */
const AVAILABLE = { sessionSecret: 'test-session-secret' };

/** A device key, as the client makes one: P-256, exported as the SPKI DER a server can read. */
function newDeviceKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        // DER-encoded ECDSA over SHA-256, which is what CryptoKit signs.
        sign: (payload) => crypto.sign('sha256', payload, privateKey).toString('base64'),
    };
}

function signedBytes({ deviceId, challengeId, nonce }) {
    return Buffer.from(`${SIGNED_PREFIX}\n${deviceId}\n${challengeId}\n${nonce}`, 'utf8');
}

function bearer(token) {
    return { authorization: `Bearer ${token}` };
}

async function invite(base, userId, extra = {}) {
    return api(base, 'abdullah@dev', '/api/admin/enrollments', {
        method: 'POST',
        body: { userId, ...extra },
    });
}

async function enrol(base, token, key, body = {}) {
    return api(base, null, '/api/auth/enroll', {
        method: 'POST',
        body: {
            token,
            publicKey: key.publicKey,
            algorithm: 'ES256',
            deviceName: 'Test iPhone',
            platform: 'ios',
            ...body,
        },
    });
}

/** The whole handshake, as a device performs it. */
async function authenticate(base, deviceId, key) {
    const challenge = await api(base, null, '/api/auth/challenge', { method: 'POST', body: { deviceId } });
    assert.equal(challenge.status, 200, `challenge refused: ${JSON.stringify(challenge.data)}`);
    const { challengeId, nonce } = challenge.data;
    return api(base, null, '/api/auth/session', {
        method: 'POST',
        body: { deviceId, challengeId, signature: key.sign(signedBytes({ deviceId, challengeId, nonce })) },
    });
}

/** An invitation created without going through the API, for a server that demands a key. */
function inviteDirectly(server, userId, extra = {}) {
    return auth.createInvitation({
        store: server.store,
        config: server.config,
        now: new Date().toISOString(),
        userId,
        ...extra,
    });
}

/** Admin invites, device enrols: the ordinary way a phone arrives. */
async function enrolledDevice(base, userId = 'dad') {
    const invitation = await invite(base, userId);
    assert.equal(invitation.status, 201, JSON.stringify(invitation.data));
    const key = newDeviceKey();
    const enrolled = await enrol(base, invitation.data.payload.enrollment_token, key);
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.data));
    return { key, ...enrolled.data, enrollmentToken: invitation.data.payload.enrollment_token };
}

// ── Enrolment ───────────────────────────────────────────────────────────────────

test('an invitation admits one device, and then cannot be used again', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const { device, session } = await enrolledDevice(base);
    assert.match(device.id, /^dev_/);
    assert.ok(session.token, 'enrolment hands back a session');

    // The key is the device's; the server never sees the private half.
    const second = await enrol(base, (await invite(base, 'dad')).data.payload.enrollment_token, newDeviceKey());
    assert.equal(second.status, 200, 'a fresh invitation still works');

    const again = await invite(base, 'mum');
    const first = await enrol(base, again.data.payload.enrollment_token, newDeviceKey());
    assert.equal(first.status, 200);
    const replay = await enrol(base, again.data.payload.enrollment_token, newDeviceKey());
    assert.equal(replay.status, 409);
    assert.equal(replay.data.error.code, 'ENROLLMENT_USED');
});

test('a token that is not an invitation gets nowhere', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const made = await invite(base, 'dad');
    const wrong = await enrol(base, `${made.data.payload.enrollment_token}x`, newDeviceKey());
    assert.equal(wrong.status, 401);
    assert.equal(wrong.data.error.code, 'ENROLLMENT_INVALID');
});

test('an invitation expires', async (t) => {
    const { server, base } = await startTestServer({ ...AVAILABLE, enrollmentTtlSeconds: 1 });
    t.after(() => server.close());

    const made = await invite(base, 'dad');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const late = await enrol(base, made.data.payload.enrollment_token, newDeviceKey());
    assert.equal(late.status, 410);
    assert.equal(late.data.error.code, 'ENROLLMENT_EXPIRED');
});

test('an invitation that was withdrawn cannot be redeemed', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const made = await invite(base, 'dad');
    const revoked = await api(base, 'abdullah@dev', `/api/admin/enrollments/${made.data.enrollment.id}/revoke`, { method: 'POST' });
    assert.equal(revoked.status, 200);

    const refused = await enrol(base, made.data.payload.enrollment_token, newDeviceKey());
    assert.equal(refused.status, 403);
    assert.equal(refused.data.error.code, 'ENROLLMENT_REVOKED');
});

test('a device key that is not a P-256 key is refused before anything else happens', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const made = await invite(base, 'dad');
    const wrongCurve = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const refused = await enrol(base, made.data.payload.enrollment_token, {
        publicKey: wrongCurve.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.data.error.code, 'DEVICE_KEY_INVALID');
});

test('an invitation always names the person it is for', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const withoutUser = await api(base, 'abdullah@dev', '/api/admin/enrollments', { method: 'POST', body: {} });
    assert.equal(withoutUser.status, 404, 'a user that does not exist is not an invitation target');
});

// ── Challenge and response ──────────────────────────────────────────────────────

test('answering a challenge earns a session, and the session is the identity', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const { key, device } = await enrolledDevice(base, 'dad');
    const answered = await authenticate(base, device.id, key);
    assert.equal(answered.status, 200, JSON.stringify(answered.data));
    assert.equal(answered.data.user.id, 'dad');

    // The session stands on its own: no identity header, no tailnet, just the token.
    const bootstrap = await api(base, null, '/api/bootstrap', { headers: bearer(answered.data.session.token) });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.data.user.id, 'dad');

    // And a session that has been tampered with is not a session.
    const forged = await api(base, null, '/api/bootstrap', { headers: bearer(`${answered.data.session.token}x`) });
    assert.equal(forged.status, 401);
});

test('a signature over the wrong bytes is refused, and costs the challenge', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const { key, device } = await enrolledDevice(base);
    const challenge = await api(base, null, '/api/auth/challenge', { method: 'POST', body: { deviceId: device.id } });
    const { challengeId, nonce } = challenge.data;

    // Signed, but over a challenge id of the device's own choosing.
    const wrong = await api(base, null, '/api/auth/session', {
        method: 'POST',
        body: {
            deviceId: device.id,
            challengeId,
            signature: key.sign(signedBytes({ deviceId: device.id, challengeId: 'chl_somethingelse', nonce })),
        },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.data.error.code, 'SIGNATURE_INVALID');

    // The attempt spent the challenge: the same one cannot be answered again, so a
    // captured challenge is worth exactly one guess.
    const replay = await api(base, null, '/api/auth/session', {
        method: 'POST',
        body: { deviceId: device.id, challengeId, signature: key.sign(signedBytes({ deviceId: device.id, challengeId, nonce })) },
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.data.error.code, 'CHALLENGE_INVALID');
});

test('another device cannot answer a challenge that is not its own', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const first = await enrolledDevice(base, 'dad');
    const second = await enrolledDevice(base, 'mum');
    const challenge = await api(base, null, '/api/auth/challenge', { method: 'POST', body: { deviceId: first.device.id } });

    // The challenge belongs to the device it was issued to, not to whoever holds it.
    const stolen = await api(base, null, '/api/auth/session', {
        method: 'POST',
        body: {
            deviceId: second.device.id,
            challengeId: challenge.data.challengeId,
            signature: second.key.sign(signedBytes({
                deviceId: second.device.id,
                challengeId: challenge.data.challengeId,
                nonce: challenge.data.nonce,
            })),
        },
    });
    assert.equal(stolen.status, 401);
    assert.equal(stolen.data.error.code, 'CHALLENGE_INVALID');
});

test('an unknown device cannot ask for a challenge', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const unknown = await api(base, null, '/api/auth/challenge', { method: 'POST', body: { deviceId: 'dev_notarealdevice' } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.data.error.code, 'DEVICE_UNKNOWN');
});

test('a challenge expires', async (t) => {
    const { server, base } = await startTestServer({ ...AVAILABLE, challengeTtlSeconds: 1 });
    t.after(() => server.close());

    const { key, device } = await enrolledDevice(base);
    const challenge = await api(base, null, '/api/auth/challenge', { method: 'POST', body: { deviceId: device.id } });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const late = await api(base, null, '/api/auth/session', {
        method: 'POST',
        body: {
            deviceId: device.id,
            challengeId: challenge.data.challengeId,
            signature: key.sign(signedBytes({
                deviceId: device.id,
                challengeId: challenge.data.challengeId,
                nonce: challenge.data.nonce,
            })),
        },
    });
    assert.equal(late.status, 410);
    assert.equal(late.data.error.code, 'CHALLENGE_EXPIRED');
});

test('a session expires', async (t) => {
    const { server, base } = await startTestServer({ ...AVAILABLE, sessionTtlSeconds: 1 });
    t.after(() => server.close());

    const { key, device } = await enrolledDevice(base);
    const answered = await authenticate(base, device.id, key);
    assert.equal(answered.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const late = await api(base, null, '/api/bootstrap', { headers: bearer(answered.data.session.token) });
    assert.equal(late.status, 401);
});

// ── Revocation ──────────────────────────────────────────────────────────────────

test('a revoked device cannot authenticate, and the session it already had stops working', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const { key, device } = await enrolledDevice(base);
    const live = await authenticate(base, device.id, key);
    assert.equal(live.status, 200);
    assert.equal((await api(base, null, '/api/bootstrap', { headers: bearer(live.data.session.token) })).status, 200);

    const revoked = await api(base, 'abdullah@dev', `/api/admin/devices/${device.id}/revoke`, { method: 'POST' });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.device.status, 'revoked');

    // A correctly signed token is still refused, because the device is looked up on
    // every use rather than trusted because the signature checks out.
    const after = await api(base, null, '/api/bootstrap', { headers: bearer(live.data.session.token) });
    assert.equal(after.status, 401);

    const challenge = await api(base, null, '/api/auth/challenge', { method: 'POST', body: { deviceId: device.id } });
    assert.equal(challenge.status, 403);
    assert.equal(challenge.data.error.code, 'DEVICE_REVOKED');
});

test('revoking one device leaves the person, and their other devices, alone', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const oldPhone = await enrolledDevice(base, 'dad');
    const newPhone = await enrolledDevice(base, 'dad');

    await api(base, 'abdullah@dev', `/api/admin/devices/${oldPhone.device.id}/revoke`, { method: 'POST' });

    const stillWorks = await authenticate(base, newPhone.device.id, newPhone.key);
    assert.equal(stillWorks.status, 200);
    assert.equal(stillWorks.data.user.id, 'dad');

    const people = await api(base, 'abdullah@dev', '/api/admin/users');
    assert.equal(people.data.users.find((user) => user.id === 'dad').activeDevices, 1);
});

// ── Where device authentication is required ─────────────────────────────────────

test('where a device key is required, a transport identity is not enough', async (t) => {
    const { server, base } = await startTestServer({ ...AVAILABLE, requireDeviceAuth: true });
    t.after(() => server.close());

    // The identity header is exactly what a private deployment trusts today.
    const refused = await api(base, 'abdullah@dev', '/api/bootstrap');
    assert.equal(refused.status, 401);
    assert.equal(refused.data.error.code, 'DEVICE_AUTH_REQUIRED');

    // The socket is where calls happen, so it applies the same rule.
    const handshake = await new Promise((resolve) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/socket.io/?EIO=4&transport=websocket`, {
            headers: { 'x-dev-identity': 'abdullah@dev' },
        });
        ws.on('error', (error) => resolve(String(error.message)));
        ws.on('message', () => resolve('opened'));
    });
    assert.match(handshake, /401|Unexpected server response/);
});

test('where a device key is required, an enrolled device works end to end', async (t) => {
    const { server, base } = await startTestServer({ ...AVAILABLE, requireDeviceAuth: true });
    t.after(() => server.close());

    // The invitation is made directly, because the admin API is itself gated by the
    // rule under test.
    const invitation = inviteDirectly(server, 'dad');
    assert.equal(invitation.ok, true, invitation.reason);
    const key = newDeviceKey();
    const enrolled = await enrol(base, invitation.token, key);
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.data));

    const answered = await authenticate(base, enrolled.data.device.id, key);
    assert.equal(answered.status, 200);
    const bootstrap = await api(base, null, '/api/bootstrap', { headers: bearer(answered.data.session.token) });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.data.user.id, 'dad');

    // Nobody is discoverable until they have signed in, and in this mode signing in
    // means presenting a device key — which is why the admin's own device is the first
    // thing that has to be enrolled.
    assert.deepEqual(bootstrap.data.contacts.map((contact) => contact.id), []);
});

test('a private deployment with no session secret says so rather than half-working', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    const refused = await api(base, null, '/api/auth/challenge', { method: 'POST', body: { deviceId: 'dev_whatever1234' } });
    assert.equal(refused.status, 404);
    assert.equal(refused.data.error.code, 'DEVICE_AUTH_DISABLED');
});

// ── Authorization ───────────────────────────────────────────────────────────────

test('only an administrator may manage devices', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const asDad = await api(base, 'dad@dev', '/api/admin/devices');
    assert.equal(asDad.status, 403);
    assert.equal(asDad.data.error.code, 'NOT_ADMIN');

    const asAdmin = await api(base, 'abdullah@dev', '/api/admin/devices');
    assert.equal(asAdmin.status, 200);

    // Manage means manage: a household member cannot revoke somebody else's phone.
    const target = await enrolledDevice(base, 'mum');
    const denied = await api(base, 'dad@dev', `/api/admin/devices/${target.device.id}/revoke`, { method: 'POST' });
    assert.equal(denied.status, 403);
    assert.equal((await authenticate(base, target.device.id, target.key)).status, 200);
});

test('an enrolled device may read its own identity, and only its own', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const dad = await enrolledDevice(base, 'dad');
    const answered = await authenticate(base, dad.device.id, dad.key);

    const mine = await api(base, null, '/api/device', { headers: bearer(answered.data.session.token) });
    assert.equal(mine.status, 200);
    assert.equal(mine.data.enrolled, true);
    assert.equal(mine.data.device.id, dad.device.id);
    assert.equal(mine.data.device.name, 'Test iPhone');

    // Nothing of another person's device appears here.
    const mum = await enrolledDevice(base, 'mum');
    assert.equal(JSON.stringify(mine.data).includes(mum.device.id), false);

    // A request with no session at all is told plainly that it is not enrolled.
    const anonymous = await api(base, 'dad@dev', '/api/device');
    assert.equal(anonymous.data.enrolled, false);
});

// ── Relay credentials ───────────────────────────────────────────────────────────

test('an authenticated device is handed relay credentials that expire', async (t) => {
    const turn = { host: 'turn.example.com', port: 3478, minPort: 49160, maxPort: 49200, sharedSecret: 'turn-shared-secret', ttlSeconds: 600 };
    const { server, base } = await startTestServer({ ...AVAILABLE, turn });
    t.after(() => server.close());

    const device = await enrolledDevice(base, 'dad');
    const answered = await authenticate(base, device.device.id, device.key);
    const ice = await api(base, null, '/api/webrtc/ice', { headers: bearer(answered.data.session.token) });
    assert.equal(ice.status, 200);

    const relay = ice.data.iceServers.find((entry) => String(entry.urls).includes('turn:'));
    assert.ok(relay, 'a relay is offered');
    assert.deepEqual(relay.urls, [
        'turn:turn.example.com:3478?transport=udp',
        'turn:turn.example.com:3478?transport=tcp',
    ]);

    // coturn's REST scheme, checked here rather than assumed: the username carries the
    // expiry and the name of the device it was issued to, and the credential is an HMAC
    // of that username under a secret only the server and the relay hold.
    const [expiry, name] = relay.username.split(':');
    assert.equal(name, device.device.id);
    const expected = crypto.createHmac('sha1', turn.sharedSecret).update(relay.username).digest('base64');
    assert.equal(relay.credential, expected);

    const remaining = Number(expiry) * 1000 - Date.now();
    assert.ok(remaining > 0, 'the credential is still valid');
    assert.ok(remaining <= turn.ttlSeconds * 1000, 'and expires within the stated TTL');
    assert.equal(ice.data.ttl, turn.ttlSeconds);

    // A credential that has to be asked for is a credential that can be withheld.
    assert.equal((await api(base, null, '/api/webrtc/ice')).status, 401);
});

test('a revoked device is not given relay credentials', async (t) => {
    const turn = { host: 'turn.example.com', port: 3478, minPort: 49160, maxPort: 49200, sharedSecret: 'turn-shared-secret', ttlSeconds: 600 };
    const { server, base } = await startTestServer({ ...AVAILABLE, turn });
    t.after(() => server.close());

    const device = await enrolledDevice(base, 'dad');
    const answered = await authenticate(base, device.device.id, device.key);
    await api(base, 'abdullah@dev', `/api/admin/devices/${device.device.id}/revoke`, { method: 'POST' });

    const refused = await api(base, null, '/api/webrtc/ice', { headers: bearer(answered.data.session.token) });
    assert.equal(refused.status, 401);
});

test('a deployment with no relay offers STUN and no credentials to leak', async (t) => {
    const { server, base } = await startTestServer(AVAILABLE);
    t.after(() => server.close());

    const device = await enrolledDevice(base, 'dad');
    const answered = await authenticate(base, device.device.id, device.key);
    const ice = await api(base, null, '/api/webrtc/ice', { headers: bearer(answered.data.session.token) });

    assert.equal(ice.status, 200);
    assert.deepEqual(ice.data.iceServers, [{ urls: 'stun:example.invalid:3478' }]);
    assert.equal(ice.data.ttl, 0);
});

// ── Health ──────────────────────────────────────────────────────────────────────

test('health answers without a session and says nothing worth having', async (t) => {
    const { server, base } = await startTestServer({ ...AVAILABLE, requireDeviceAuth: true });
    t.after(() => server.close());

    const health = await api(base, null, '/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.data, { status: 'ok', mode: 'private' });
});
