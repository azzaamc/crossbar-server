'use strict';

// Both modes are the same server, and this is what holds that: the same directory, the same
// device, the same requests, answered the same way. The one deliberate difference — what a
// request is allowed to prove about who sent it — is asserted rather than assumed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const auth = require('../src/auth');
const { startTestServer, api } = require('./helpers');

const PRIVATE = {
    networkMode: 'private',
    trustTailscaleHeaders: true,
    allowDevIdentity: true,
    // Available here and required in public: the difference the modes are allowed to have is
    // what they demand, not what they can recognise.
    requireDeviceAuth: false,
    sessionSecret: 'parity-secret',
};

const PUBLIC = {
    networkMode: 'public',
    trustTailscaleHeaders: false,
    allowDevIdentity: false,
    publicHostname: 'crossbar.example.com',
    publicOrigin: 'http://127.0.0.1',
    requireDeviceAuth: true,
    sessionSecret: 'parity-secret',
};

/** A device key, as a client makes one: P-256, exported as the SPKI DER a server can read. */
function deviceKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        sign: (payload) => crypto.sign('sha256', payload, privateKey).toString('base64'),
    };
}

/** Enrols a device against whichever mode this server is in, and answers with its session. */
async function enrolledDevice(server, base) {
    const invitation = auth.createInvitation({
        store: server.store,
        config: server.config,
        now: new Date().toISOString(),
        userId: 'abdullah',
    });
    const created = await api(base, null, '/api/auth/enroll', {
        method: 'POST',
        body: {
            token: invitation.token,
            publicKey: deviceKey().publicKey,
            algorithm: 'ES256',
            deviceName: 'Parity',
            platform: 'ios',
        },
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    return { deviceId: created.data.device.id, token: created.data.session.token };
}

const asDevice = (base, device, route) => api(base, null, route, {
    headers: { authorization: `Bearer ${device.token}` },
});

test('the same device is answered the same way in either mode', async (t) => {
    const seen = {};

    for (const [mode, overrides] of Object.entries({ private: PRIVATE, public: PUBLIC })) {
        const { server, base } = await startTestServer(overrides);
        t.after(() => server.close());
        const device = await enrolledDevice(server, base);

        const bootstrap = await asDevice(base, device, '/api/bootstrap');
        const ice = await asDevice(base, device, '/api/webrtc/ice');
        const status = await asDevice(base, device, '/api/admin/status');
        const users = await asDevice(base, device, '/api/admin/users');
        const devices = await asDevice(base, device, '/api/admin/devices');
        const consolePage = await fetch(`${base}/admin`);

        seen[mode] = {
            user: Object.keys(bootstrap.data.user).sort(),
            me: bootstrap.data.user.displayName,
            admin: bootstrap.data.user.admin,
            contacts: bootstrap.data.contacts.map((contact) => contact.id).sort(),
            groups: bootstrap.data.groups.map((group) => group.id).sort(),
            calls: bootstrap.data.calls,
            ice: Object.keys(ice.data).sort(),
            status: Object.keys(status.data).sort(),
            people: users.data.users.map((user) => user.id).sort(),
            devicePlatforms: devices.data.devices.map((item) => item.platform).sort(),
            console: consolePage.status,
        };
    }

    // What a directory member can see and do does not change with the mode. The mode is a
    // difference in what is trusted, never in what the app is.
    assert.deepEqual(seen.public, seen.private);
});

test('what differs is what a request may prove, and that it does', async (t) => {
    const bases = {};
    const sources = {};

    for (const [mode, overrides] of Object.entries({ private: PRIVATE, public: PUBLIC })) {
        const { server, base } = await startTestServer(overrides);
        t.after(() => server.close());
        bases[mode] = base;
        const device = await enrolledDevice(server, base);
        // A device is the canonical identity in both modes: where a key has answered a
        // challenge, nothing the transport says can make it more true.
        sources[mode] = (await asDevice(base, device, '/api/session')).data.identity.source;
    }

    assert.equal(sources.private, 'device');
    assert.equal(sources.public, 'device');

    // Where they part: private mode also believes the identity header a local proxy injects,
    // and public mode believes nothing a request says about itself at all.
    const asProxy = await api(bases.private, 'abdullah@dev', '/api/bootstrap');
    const asStranger = await api(bases.public, 'abdullah@dev', '/api/bootstrap');
    assert.equal(asProxy.status, 200);
    assert.equal(asStranger.status, 401);
    assert.equal(asStranger.data.error.code, 'DEVICE_AUTH_REQUIRED');
});
