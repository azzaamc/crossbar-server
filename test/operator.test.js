'use strict';

// The operator's own tooling, on the machine, in public mode.
//
// Public mode refuses a login and demands a device key of every client, which is right —
// but it used to mean the box could not run its own CLI the moment it went public, which is
// the moment that CLI is for. The credential added here is derived from the session secret
// and believed only from loopback; this file holds both halves of that, and holds the
// refusal that must not move.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const identity = require('../src/identity');
const { startTestServer, api } = require('./helpers');

const SECRET = 'operator-test-secret';

/** Public mode as the deployment is measured: a login is not a credential, a device key is. */
const PUBLIC = {
    networkMode: 'public',
    trustTailscaleHeaders: false,
    allowDevIdentity: false,
    publicHostname: 'crossbar.example.com',
    publicOrigin: 'http://127.0.0.1',
    requireDeviceAuth: true,
    sessionSecret: SECRET,
};

/** The header on the wire, spelled out rather than imported: this file states the contract. */
const HEADER = 'x-crossbar-operator';

/** The refusal both reported symptoms arrive as. */
const REFUSAL = { error: { code: 'DEVICE_AUTH_REQUIRED', message: 'This device is not enrolled with this server.' } };

function operator(config) {
    return { [HEADER]: identity.operatorToken(config) };
}

test('a token derived from the session secret is believed from loopback, and the login it carries names that person', async (t) => {
    const { server, base, config } = await startTestServer(PUBLIC);
    t.after(() => server.close());

    // The invitee has to be someone who has arrived before they can be rung, which is what
    // the same credential establishes for them.
    const dad = await api(base, null, '/api/session', {
        headers: { 'tailscale-user-login': 'dad@dev', ...operator(config) },
    });
    assert.equal(dad.data.user?.id, 'dad', JSON.stringify(dad.data));

    const me = await api(base, null, '/api/session', {
        headers: { 'tailscale-user-login': 'abdullah@dev', ...operator(config) },
    });
    assert.equal(me.status, 200);
    assert.equal(me.data.authenticated, true);
    assert.equal(me.data.identity.source, 'tailscale', 'believed as the proxy header is believed in private mode');
    assert.equal(me.data.user.id, 'abdullah', 'the login resolves to the person it names');

    // The route the reported symptom is on: `ring --from abdullah --to dad`.
    const ring = await api(base, null, '/api/calls', {
        method: 'POST',
        headers: { 'tailscale-user-login': 'abdullah@dev', ...operator(config) },
        body: { inviteeIds: ['dad'], video: true },
    });
    assert.equal(ring.status, 201, JSON.stringify(ring.data));
    assert.equal(ring.data.call.callerId, 'abdullah');
    assert.equal(ring.data.call.callerName, 'Abdullah');
});

test('without the token, or with a wrong one, loopback is refused exactly as it is today', async (t) => {
    const { server, base, config } = await startTestServer(PUBLIC);
    t.after(() => server.close());

    const none = await api(base, null, '/api/admin/status', {
        headers: { 'tailscale-user-login': 'abdullah@dev' },
    });
    assert.equal(none.status, 401);
    assert.deepEqual(none.data, REFUSAL);

    // A wrong token of the same length, which is the comparison that has to stay constant
    // time, and a short one, which never reaches it.
    for (const wrong of ['f'.repeat(64), 'nope']) {
        const refused = await api(base, null, '/api/admin/status', {
            headers: { 'tailscale-user-login': 'abdullah@dev', [HEADER]: wrong },
        });
        assert.equal(refused.status, 401, `a ${wrong.length}-character wrong token must not be believed`);
        assert.deepEqual(refused.data, REFUSAL);
    }

    // And the same on the CLI's own route, which is the one the operator actually runs.
    const ring = await api(base, null, '/api/calls', {
        method: 'POST',
        headers: { 'tailscale-user-login': 'abdullah@dev', [HEADER]: 'f'.repeat(64) },
        body: { inviteeIds: ['dad'], video: true },
    });
    assert.equal(ring.status, 401);
    assert.deepEqual(ring.data, REFUSAL);

    // The credential carries nothing in private mode either: it is the same secret, and the
    // header is simply not consulted there.
    assert.equal(identity.operatorToken(config), identity.operatorToken({ sessionSecret: SECRET }));
});

test('the token is not believed when the request did not arrive from loopback', async (t) => {
    const { server, config } = await startTestServer(PUBLIC);
    t.after(() => server.close());

    // The listener binds loopback, so no request from anywhere else can be produced on this
    // host: the address is supplied directly, and the identical headers are offered over
    // both addresses so that the address is the only difference between the two answers.
    const headers = { 'tailscale-user-login': 'abdullah@dev', ...operator(config) };
    const believed = identity.resolveIdentity({ socket: { remoteAddress: '127.0.0.1' }, headers }, config);
    assert.equal(believed?.login, 'abdullah@dev', 'the token itself is valid; this is the control');

    for (const address of ['203.0.113.9', '::ffff:10.0.0.7', '']) {
        assert.equal(
            identity.resolveIdentity({ socket: { remoteAddress: address }, headers }, config),
            null,
            `${address || '(no address)'} must not be believed`,
        );
    }
});

test('the token is not the session secret, and one derived from a different secret is refused', async (t) => {
    const { server, base, config } = await startTestServer(PUBLIC);
    t.after(() => server.close());

    const token = identity.operatorToken(config);
    assert.equal(token, identity.operatorToken({ sessionSecret: SECRET }));
    assert.notEqual(token, SECRET, 'the credential is derived; presenting the secret itself must not work');
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(identity.operatorToken({ sessionSecret: 'a-different-secret' }), token);

    // A token from another secret does not carry over, which is what makes rotating the
    // session secret revoke it.
    const foreign = await api(base, null, '/api/admin/status', {
        headers: {
            'tailscale-user-login': 'abdullah@dev',
            [HEADER]: identity.operatorToken({ sessionSecret: 'a-different-secret' }),
        },
    });
    assert.equal(foreign.status, 401);
    assert.deepEqual(foreign.data, REFUSAL);

    // Nor does the secret itself, presented as if it were the token.
    const asSecret = await api(base, null, '/api/admin/status', {
        headers: { 'tailscale-user-login': 'abdullah@dev', [HEADER]: SECRET },
    });
    assert.equal(asSecret.status, 401);
    assert.deepEqual(asSecret.data, REFUSAL);
});

test('Caddy strips the operator header before it can reach the server', () => {
    // A text assertion, because the file is Caddy configuration and cannot be executed in
    // this environment: what is checked is that the strip line exists, that it names the
    // header the CLI sends, and that it sits in the block that strips the other
    // client-supplied identity headers rather than somewhere that does not run.
    const caddyfile = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'Caddyfile'), 'utf8');
    assert.match(caddyfile, /^\s*request_header -X-Crossbar-Operator$/m);

    const stripBlock = caddyfile.slice(
        caddyfile.indexOf('request_header -Tailscale-User-Login'),
        caddyfile.indexOf('reverse_proxy'),
    );
    assert.ok(stripBlock.includes('request_header -X-Crossbar-Operator'), 'in the same block as the rest');
    assert.ok(stripBlock.includes('request_header -X-Dev-Identity'), 'which is the block that already runs');
});
