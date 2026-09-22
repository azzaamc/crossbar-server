'use strict';

// The operator console is served by the Crossbar server itself: the same origin as the
// API it calls, and the same identity rules. What matters here is that it is reachable,
// that its own files are the only files it can reach, and that the page gives nothing
// away on its own — every fact on it comes from a route that checks who is asking.

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, api } = require('./helpers');
const auth = require('../src/auth');

const PASSWORD = 'a-console-password-for-testing';
const WITH_PASSWORD = {
    sessionSecret: 'console-test-secret',
    adminPasswordHash: auth.hashPassword(PASSWORD),
};

async function get(base, route) {
    const response = await fetch(`${base}${route}`);
    return {
        status: response.status,
        type: response.headers.get('content-type') || '',
        body: await response.text(),
    };
}

/** Signs in with a password, and answers with whatever cookie came back. */
async function signIn(base, password) {
    const response = await fetch(`${base}/api/admin/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body, cookie: response.headers.get('set-cookie') || '' };
}

/** The cookie's first name=value pair, which is what a browser would send back. */
const cookiePair = (header) => header.split(';')[0];

test('the console is served from the server, and names its own parts', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    const page = await get(base, '/admin');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.body, /\/admin\/admin\.js/);
    // Nothing inline: the policy the server sends is `script-src 'self'`.
    assert.doesNotMatch(page.body, /<script>(?!\s*<\/script>)/);
});

test('its own files are served, and nothing above them', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    assert.equal((await get(base, '/admin')).status, 200);
    assert.equal((await get(base, '/admin/')).status, 200);
    assert.equal((await get(base, '/admin/admin.js')).status, 200);
    assert.equal((await get(base, '/admin/admin.css')).status, 200);
    // The page loads these by name, so they have to be there under those names.
    assert.equal((await get(base, '/admin/device.js')).status, 200);
    assert.equal((await get(base, '/admin/qrcode.js')).status, 200);
    assert.equal((await get(base, '/admin/nothing-here')).status, 404);
    // A path that climbs out of the console's directory is refused, never resolved.
    assert.equal((await get(base, '/admin/..%2fsrc%2fserver.js')).status, 400);
    assert.equal((await get(base, '/admin/%2e%2e%2fsrc%2fserver.js')).status, 400);
});

test('the page is public and every fact on it is not', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    // Whoever asks gets the page; it carries no household data of its own.
    const page = await get(base, '/admin');
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.body, /abdullah/i);

    // The data behind it does not.
    assert.equal((await api(base, null, '/api/admin/status')).status, 401);
    assert.equal((await api(base, 'dad@dev', '/api/admin/status')).status, 403);
    assert.equal((await api(base, 'abdullah@dev', '/api/admin/status')).status, 200);
});

test('a password opens the console, and only the console', async (t) => {
    const { server, base } = await startTestServer(WITH_PASSWORD);
    t.after(() => server.close());

    const refused = await signIn(base, 'not-it');
    assert.equal(refused.status, 401);
    assert.equal(refused.body.error.code, 'PASSWORD_INVALID');
    assert.equal(refused.cookie, '', 'a refusal sets no session');

    const opened = await signIn(base, PASSWORD);
    assert.equal(opened.status, 200);
    // The cookie is the session, and it is one no script can read.
    assert.match(opened.cookie, /^crossbar_admin=v1\./);
    assert.match(opened.cookie, /HttpOnly/);
    assert.match(opened.cookie, /SameSite=Strict/);

    const cookie = cookiePair(opened.cookie);
    const status = await fetch(`${base}/api/admin/status`, { headers: { cookie } });
    assert.equal(status.status, 200);

    // And it answers for the console's routes and nothing else: a browser holding it is not
    // a household member, and must not be able to act as one.
    const bootstrap = await fetch(`${base}/api/bootstrap`, { headers: { cookie } });
    assert.equal(bootstrap.status, 401);

    // Closing it takes the session away again.
    const closed = await fetch(`${base}/api/admin/signout`, { method: 'POST', headers: { cookie } });
    assert.equal(closed.status, 200);
    assert.match(closed.headers.get('set-cookie') || '', /Max-Age=0/);
});

test('a server with no password set says so, and a password is not guessed at', async (t) => {
    const { server, base } = await startTestServer({ sessionSecret: 'console-test-secret' });
    t.after(() => server.close());

    const unanswered = await signIn(base, PASSWORD);
    assert.equal(unanswered.status, 404);
    assert.equal(unanswered.body.error.code, 'OPERATOR_DISABLED');

    // Nothing to answer, and nothing to guess at either.
    assert.equal((await api(base, null, '/api/admin/status')).status, 401);
});

test('guessing is rate limited', async (t) => {
    const { server, base } = await startTestServer(WITH_PASSWORD);
    t.after(() => server.close());

    const answers = [];
    for (let attempt = 0; attempt < 7; attempt += 1) answers.push((await signIn(base, 'wrong')).status);
    assert.equal(answers.at(-1), 429, `attempts: ${answers.join(', ')}`);
    // And the right password is behind the same limit, not beside it.
    assert.equal((await signIn(base, PASSWORD)).status, 429);
});

test('the household can be changed from the console, and suspending is not removing', async (t) => {
    const { server, base } = await startTestServer(WITH_PASSWORD);
    t.after(() => server.close());
    const { cookie } = await signIn(base, PASSWORD);
    const asOperator = async (route, body) => {
        const response = await fetch(`${base}${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: cookiePair(cookie) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, data: await response.json().catch(() => ({})) };
    };

    const added = await asOperator('/api/admin/people', {
        id: 'sara',
        displayName: 'Sara',
        tailscaleLogin: 'sara@example.com',
    });
    assert.equal(added.status, 201, JSON.stringify(added.data));
    assert.ok(added.data.users.some((user) => user.id === 'sara'));

    // Suspended: still a member of the household, no longer somebody who can be signed in as.
    assert.equal((await asOperator('/api/admin/people/sara', { enabled: false })).status, 200);
    assert.equal(server.store.userById('sara'), null);
    assert.ok(server.store.listUsers().some((user) => user.id === 'sara'), 'still in the household');

    // Restored, and able to be recognised again.
    assert.equal((await asOperator('/api/admin/people/sara', { enabled: true })).status, 200);
    assert.ok(server.store.userById('sara'));

    // A household may not lose its last administrator, whoever is asking.
    const lastAdmin = await asOperator('/api/admin/people/abdullah', { enabled: false });
    assert.equal(lastAdmin.status, 400);
    assert.equal(lastAdmin.data.error.code, 'HOUSEHOLD_INVALID');

    const removed = await asOperator('/api/admin/people/sara/remove');
    assert.equal(removed.status, 200);

    // Gone from the household — the file no longer names her — and unable to be signed in
    // as. Still in the records, which is where the calls she was part of point.
    const people = await fetch(`${base}/api/admin/people`, { headers: { cookie: cookiePair(cookie) } });
    const listed = (await people.json()).people.map((person) => person.id);
    assert.deepEqual(listed, ['abdullah', 'dad', 'mum']);
    assert.equal(server.store.userById('sara'), null);
    assert.equal(removed.data.revokedDevices, 0);

    // And the count the console shows is the household's, not the rows': her row remains,
    // which is the point, and counting it would make the server card disagree with the table.
    const status = await fetch(`${base}/api/admin/status`, { headers: { cookie: cookiePair(cookie) } });
    assert.equal((await status.json()).users, 3);
    assert.equal(server.store.listUsers().length, 4, 'the row is still there, disabled');
});
