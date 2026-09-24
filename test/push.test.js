'use strict';

// Ringing a phone that is asleep.
//
// The transport is injected here, because Apple cannot be asked from a test — and because
// everything in the request that is *ours* rather than Node's or Apple's is also the part
// whose failure is silent. A wrong topic, a wrong push type or a mis-encoded signature is
// a phone that never rings and a server that believes it rang.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createApnsNotifier, providerToken } = require('../src/apns');
const { createLifecycle } = require('../src/lifecycle');
const { startTestServer, api } = require('./helpers');

const quiet = { warn() {}, info() {}, error() {} };

/** A `.p8`, as the developer account issues one: an elliptical P-256 private key. */
function keyPair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey };
}

/** A deployment with a key, which is the only state in which anything is sent. */
function configured(overrides = {}) {
    return {
        apnsKeyId: 'ABC123DEFG',
        apnsTeamId: 'NKZHXND255',
        apnsKey: keyPair().pem,
        apnsTopic: 'com.example.Crossbar',
        callRingSeconds: 90,
        ...overrides,
    };
}

/** A transport that records what it was asked to send and answers what it is told. */
function recorder(answers = [{ status: 200, payload: '' }]) {
    const sent = [];
    return {
        sent,
        transport: {
            async send(origin, path, headers, body) {
                sent.push({ origin, path, headers, body });
                return answers.shift() || { status: 200, payload: '' };
            },
            close() {},
        },
    };
}

const ringable = [{ deviceId: 'dev_a', token: 'aabbccdd', environment: 'production' }];

const call = {
    id: 'f0f0f0f0-1111-2222-3333-444444444444',
    callerId: 'abdullah',
    kind: 'video',
    createdAt: '2026-09-22T12:00:00.000Z',
};

test('the provider token is a JWT Apple can verify', () => {
    const { pem, publicKey } = keyPair();
    const now = Date.UTC(2026, 8, 22, 12, 0, 0);
    const token = providerToken({ keyId: 'ABC123DEFG', teamId: 'NKZHXND255', privateKey: pem, now });

    const [header, claims, signature] = token.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'ES256', kid: 'ABC123DEFG' });
    assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), {
        iss: 'NKZHXND255',
        iat: Math.floor(now / 1000),
    });

    // The signature is the raw r‖s pair JOSE specifies, not the DER sequence Node produces
    // by default. That difference is most of the reason this is written out longhand, and
    // it is invisible until Apple refuses every push with nothing useful to say about why.
    const raw = Buffer.from(signature, 'base64url');
    assert.equal(raw.length, 64, 'two 32-byte halves, not a DER sequence');
    assert.ok(
        crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw),
        'and it verifies against the key that signed it',
    );
});

test('with no key it says it is disabled rather than pretending to deliver', async () => {
    const off = createApnsNotifier({ config: configured({ apnsKey: '', apnsKeyPath: '' }), log: quiet });
    assert.equal(off.enabled, false);
    assert.deepEqual(await off.incoming(ringable, call, 'Faisal'), []);
});

test('the request it builds is the one APNs documents', async () => {
    const { sent, transport } = recorder();
    const apns = createApnsNotifier({ config: configured(), log: quiet, transport });
    assert.equal(apns.enabled, true);
    assert.equal(apns.topic, 'com.example.Crossbar.voip', 'a PushKit registry may only be sent on the .voip topic');

    assert.deepEqual(await apns.incoming(ringable, call, 'Faisal'), []);

    const [request] = sent;
    assert.equal(request.origin, 'https://api.push.apple.com', 'a production token goes to the production host');
    assert.equal(request.path, '/3/device/aabbccdd', 'the device token is the address, so it is the path');
    assert.equal(request.headers['apns-topic'], 'com.example.Crossbar.voip');
    assert.equal(request.headers['apns-push-type'], 'voip');
    assert.equal(request.headers['apns-priority'], '10', 'a ring that is not urgent is not a ring');
    assert.equal(request.headers['apns-expiration'],
        String(Math.floor(Date.parse(call.createdAt) / 1000) + 90),
        'and it stops being worth delivering when the call gives up');
    assert.match(request.headers.authorization, /^bearer \S+\.\S+\.\S+$/);

    // The payload carries the whole call, because the phone has to draw it before it is
    // allowed to say anything to this server at all — and it carries `aps`, because a push
    // without one is a push APNs may decline to deliver, silently, on this side of the
    // world. The `aps` itself has nothing to show: CallKit draws the call.
    assert.deepEqual(JSON.parse(request.body), {
        aps: { 'content-available': 1 },
        callId: call.id,
        kind: 'video',
        caller: 'Faisal',
        callerId: 'abdullah',
        expiresAt: '2026-09-22T12:01:30.000Z',
    });
});

test('a sandbox token goes to the sandbox, and a dead one is handed back to be cleared', async () => {
    const { sent, transport } = recorder([{ status: 410, payload: JSON.stringify({ reason: 'Unregistered' }) }]);
    const apns = createApnsNotifier({ config: configured(), log: quiet, transport });

    const dead = await apns.incoming(
        [{ deviceId: 'dev_old', token: 'deadbeef', environment: 'sandbox' }],
        call,
        'Faisal',
    );

    assert.equal(sent[0].origin, 'https://api.sandbox.push.apple.com',
        'a token is only valid at the host that issued it');
    assert.deepEqual(dead.map((device) => device.deviceId), ['dev_old'],
        'Apple saying so is the only proof a token is dead');
});

test('an expired provider token is minted again, and another refusal is not retried', async () => {
    const attempts = [];
    const apns = (answers) => createApnsNotifier({
        config: configured(),
        log: quiet,
        transport: {
            async send() {
                attempts.push(1);
                return answers.shift();
            },
            close() {},
        },
    });

    assert.deepEqual(await apns([
        { status: 403, payload: JSON.stringify({ reason: 'ExpiredProviderToken' }) },
        { status: 200, payload: '' },
    ]).incoming(ringable, call, 'Faisal'), []);
    assert.equal(attempts.length, 2, 'Apple does not promise a provider token its full hour, and says so by name');

    attempts.length = 0;
    assert.deepEqual(await apns([{ status: 429, payload: JSON.stringify({ reason: 'TooManyProviderTokenUpdates' }) }])
        .incoming(ringable, call, 'Faisal'), []);
    assert.equal(attempts.length, 1, 'anything else is a refusal, not a reason to try twice');
});

test('a missed call is a notification, on the other topic and the other token', async () => {
    const { sent, transport } = recorder();
    const apns = createApnsNotifier({ config: configured(), log: quiet, transport });

    const dead = await apns.alert(
        [{ deviceId: 'dev_a', token: 'aabbccdd', environment: 'production' }],
        { callId: call.id, title: 'Missed call from Faisal', body: 'Video call' },
    );
    assert.deepEqual(dead, []);

    const [request] = sent;
    // The bare bundle id, not `.voip`: the topic is what decides which part of the app iOS
    // wakes, and a missed call must not arrive at the PushKit registry as an incoming one.
    assert.equal(request.headers['apns-topic'], 'com.example.Crossbar');
    assert.equal(request.headers['apns-push-type'], 'alert');
    assert.equal(request.headers['apns-collapse-id'], `missed-${call.id}`,
        'so a second push about the same call replaces the first rather than stacking');

    const payload = JSON.parse(request.body);
    assert.deepEqual(payload.aps.alert, { title: 'Missed call from Faisal', body: 'Video call' });
    assert.ok(payload.aps.sound, 'a missed call is worth making a noise about');
    assert.equal(payload.callId, call.id);
});

test('a device holds two tokens, and neither is the other', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    const now = new Date().toISOString();
    const enrol = (deviceId) => server.store.registerDevice({
        userId: 'dad', deviceId, label: 'Dad', platform: 'ios', now,
    });
    const save = (deviceId, kind, token, environment = 'production') => api(base, 'dad@dev', '/api/devices/push-token', {
        method: 'POST',
        body: { deviceId, token, environment, kind },
    });

    enrol('dev_ringme00001');
    assert.equal((await save('dev_ringme00001', 'voip', 'the-voip-one', 'sandbox')).status, 200);
    assert.equal((await save('dev_ringme00001', 'alert', 'the-alert-one')).status, 200);

    // Two slots, not one: a VoIP token and an alert token are issued to different parts of
    // the system, are valid against different hosts, and are not interchangeable — a phone
    // that can be told something is not thereby a phone that can be woken for a call.
    const device = server.store.devicesFor('dad').find((item) => item.id === 'dev_ringme00001');
    assert.equal(device.pushToken, 'the-alert-one');
    assert.deepEqual(server.store.voipTokensFor(['dad']).map((row) => [row.token, row.environment]),
        [['the-voip-one', 'sandbox']]);
    assert.deepEqual(server.store.alertTokensFor(['dad']).map((row) => row.token), ['the-alert-one']);

    // And they die independently: clearing one leaves the other where it was.
    assert.equal(server.store.clearAlertToken('dev_ringme00001'), true);
    assert.deepEqual(server.store.alertTokensFor(['dad']), []);
    assert.deepEqual(server.store.voipTokensFor(['dad']).map((row) => row.token), ['the-voip-one']);

    // Revoking is what stops a phone being woken, and the row stays.
    server.store.revokeDevice('dev_ringme00001', now);
    assert.deepEqual(server.store.voipTokensFor(['dad']), []);
    assert.ok(server.store.deviceById('dev_ringme00001'), 'taken out of use is not taken out of the records');

    // And a token Apple has refused is cleared, rather than being tried for ever.
    enrol('dev_ringme00002');
    await save('dev_ringme00002', 'voip', 'stale', 'production');
    assert.equal(server.store.clearVoipToken('dev_ringme00002'), true);
    assert.deepEqual(server.store.voipTokensFor(['dad']), []);
});

test('the console can see whether a device can be rung asleep', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    const now = new Date().toISOString();

    server.store.registerDevice({ userId: 'dad', deviceId: 'dev_quietphone1', label: 'Dad', platform: 'ios', now });
    await api(base, 'dad@dev', '/api/devices/push-token', {
        method: 'POST',
        body: { deviceId: 'dev_quietphone1', token: 'voiptoken', environment: 'production', kind: 'voip' },
    });

    // Without this the operator has no way to tell a phone that cannot be rung from a
    // deployment that cannot send, which is the first question a silent phone raises.
    // Asserted through the operator's own route, because that is what the console reads.
    const listed = await api(base, 'abdullah@dev', '/api/admin/devices');
    const phone = listed.data.devices.find((item) => item.id === 'dev_quietphone1');
    assert.equal(phone.hasVoipToken, true);
    assert.equal(phone.hasPushToken, false);
});

/**
 * A lifecycle over the running fixture's own store, with a notifier that records what it was
 * asked to send instead of sending it. The rules about *who* is told are the substance of a
 * missed call, and they are the part a real push cannot be asked about in a test.
 */
function watching(server) {
    const alerts = [];
    const lifecycle = createLifecycle({
        config: server.config,
        store: server.store,
        bus: server.bus,
        push: { incoming: async () => [] },
        apns: {
            enabled: true,
            incoming: async () => [],
            alert: async (devices, message) => {
                alerts.push({ devices, message });
                return [];
            },
        },
        log: quiet,
    });
    return { alerts, lifecycle };
}

/** A person with a phone that can be told things. */
function reachable(server, userId, deviceId, now) {
    server.store.registerDevice({ userId, deviceId, label: userId, platform: 'ios', now });
    server.store.savePushToken({ deviceId, token: `alert-for-${userId}`, environment: 'production', kind: 'alert', now });
    return deviceId;
}

test('a call nobody answered tells the people who were out, and not the one who was there', async (t) => {
    const { server } = await startTestServer();
    t.after(() => server.close());
    const { alerts, lifecycle } = watching(server);
    const now = new Date().toISOString();

    reachable(server, 'dad', 'dev_dadphone0001', now);
    reachable(server, 'mum', 'dev_mumphone0001', now);

    const call = server.store.createCall({
        id: crypto.randomUUID(),
        roomId: crypto.randomUUID(),
        callerId: 'abdullah',
        deviceId: null,
        inviteeIds: ['dad', 'mum'],
        kind: 'video',
        now,
    });

    // Mum has the app open, so the call itself told her. Telling her again in writing is how
    // an app teaches somebody to turn its notifications off.
    server.bus.add('mum', { write() {} });

    lifecycle.end({ user: { id: 'abdullah' }, callId: call.id });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(alerts.length, 1, 'one alert, for the one person who was not there');
    assert.deepEqual(alerts[0].devices.map((device) => device.deviceId), ['dev_dadphone0001']);
    assert.match(alerts[0].message.title, /^Missed call from /);
});

test('a ring that times out tells everybody who never answered, and nobody who did', async (t) => {
    const { server } = await startTestServer();
    t.after(() => server.close());
    const { alerts, lifecycle } = watching(server);
    // Older than the fixture's ringing time, so the sweep below has something to expire.
    const long = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    reachable(server, 'dad', 'dev_dadphone0002', long);
    reachable(server, 'mum', 'dev_mumphone0002', long);

    const call = server.store.createCall({
        id: crypto.randomUUID(),
        roomId: crypto.randomUUID(),
        callerId: 'abdullah',
        deviceId: null,
        inviteeIds: ['dad', 'mum'],
        kind: 'audio',
        now: long,
    });
    // Dad saw it and said no, so he is not somebody who missed it.
    server.store.respond(call.id, 'dad', 'declined', new Date().toISOString());

    lifecycle.expire();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0].devices.map((device) => device.deviceId), ['dev_mumphone0002']);
    assert.equal(alerts[0].message.body, 'Audio call');

    // And the call it is about is one she can go and look at. The alert promises a missed call,
    // and a missed call is a row in the history rather than something to answer — a notification
    // pointing at a call that is not there would be worse than none, because it moves the
    // question from "did anybody try to reach me" to "where did it go".
    const [recent] = server.store.callHistory('mum');
    assert.equal(recent.callId, call.id);
    assert.equal(recent.joinedAt, null, 'never joined, which is how the app reads a missed call');
});
