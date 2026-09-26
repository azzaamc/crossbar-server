'use strict';

// The operator console is served by the Crossbar server itself: the same origin as the
// API it calls, and the same identity rules. What matters here is that it is reachable,
// that its own files are the only files it can reach, and that the page gives nothing
// away on its own — every fact on it comes from a route that checks who is asking.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    // Whoever asks gets the page; it carries no directory data of its own.
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
    // a directory member, and must not be able to act as one.
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

test('a setting that would stop the server starting is refused, and put back', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-settings-'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'MAX_PARTICIPANTS=4\n'
        + 'CROSSBAR_TURN_MIN_PORT=49160\nCROSSBAR_TURN_MAX_PORT=49200\n');
    const { server, base } = await startTestServer({ ...WITH_PASSWORD, envFile });
    t.after(() => server.close());
    const { cookie } = await signIn(base, PASSWORD);
    const change = (changes) => fetch(`${base}/api/admin/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookiePair(cookie) },
        body: JSON.stringify({ changes }),
    });

    // A relay range that runs backwards loads into a configuration the server refuses.
    const before = fs.readFileSync(envFile, 'utf8');
    const refused = await change({ CROSSBAR_TURN_MIN_PORT: '51000', CROSSBAR_TURN_MAX_PORT: '50000' });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error.code, 'SETTINGS_REFUSED');
    assert.equal(fs.readFileSync(envFile, 'utf8'), before, 'a refused change leaves the file as it was');

    // A value it already holds is not a change, so nothing is written and nothing restarts.
    const unchanged = await change({ MAX_PARTICIPANTS: '4' });
    assert.equal(unchanged.status, 200);
    assert.deepEqual(await unchanged.json(), { ok: true, changed: false, restarting: false });
});

test('the directory can be changed from the console, and suspending is not removing', async (t) => {
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

    // Suspended: still a member of the directory, no longer somebody who can be signed in as.
    assert.equal((await asOperator('/api/admin/people/sara', { enabled: false })).status, 200);
    assert.equal(server.store.userById('sara'), null);
    assert.ok(server.store.listUsers().some((user) => user.id === 'sara'), 'still in the directory');

    // Restored, and able to be recognised again.
    assert.equal((await asOperator('/api/admin/people/sara', { enabled: true })).status, 200);
    assert.ok(server.store.userById('sara'));

    // A directory may not lose its last administrator, whoever is asking.
    const lastAdmin = await asOperator('/api/admin/people/abdullah', { enabled: false });
    assert.equal(lastAdmin.status, 400);
    assert.equal(lastAdmin.data.error.code, 'DIRECTORY_INVALID');

    const removed = await asOperator('/api/admin/people/sara/remove');
    assert.equal(removed.status, 200);

    // Gone from the directory — the file no longer names her — and unable to be signed in
    // as. Still in the records, which is where the calls she was part of point.
    const people = await fetch(`${base}/api/admin/people`, { headers: { cookie: cookiePair(cookie) } });
    const listed = (await people.json()).people.map((person) => person.id);
    assert.deepEqual(listed, ['abdullah', 'dad', 'mum']);
    assert.equal(server.store.userById('sara'), null);
    assert.equal(removed.data.revokedDevices, 0);

    // And the count the console shows is the directory's, not the rows': her row remains,
    // which is the point, and counting it would make the server card disagree with the table.
    const status = await fetch(`${base}/api/admin/status`, { headers: { cookie: cookiePair(cookie) } });
    assert.equal((await status.json()).users, 3);
    assert.equal(server.store.listUsers().length, 4, 'the row is still there, disabled');
});

/** Adds somebody through the console, as the operator's browser does. */
async function addPerson(base, cookie, person) {
    const response = await fetch(`${base}/api/admin/people`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookiePair(cookie) },
        body: JSON.stringify(person),
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
}

test('a person without a login is saved with a warning where a login is how people are found', async (t) => {
    const { server, base } = await startTestServer(WITH_PASSWORD);
    t.after(() => server.close());
    const { cookie } = await signIn(base, PASSWORD);

    // Saved, not refused. A device that has enrolled is a complete identity on its own, so a
    // person with no login can still use this server — they are found by their own device rather
    // than by the network saying who they are. Refusing the write was stricter than the server
    // is, and it left an operator unable to add the very login it was complaining about.
    const added = await addPerson(base, cookie, { id: 'sara', displayName: 'Sara' });
    assert.equal(added.status, 201, JSON.stringify(added.data));

    // The console is still told to ask for a login, and is told who has none, so what used to be
    // a refusal to save is now a directory that saves and says who cannot be found by name.
    const listed = await fetch(`${base}/api/admin/people`, { headers: { cookie: cookiePair(cookie) } });
    const page = await listed.json();
    assert.equal(page.requireLogins, true);
    assert.ok(page.people.some((person) => person.id === 'sara'), 'the person is in the directory');
    assert.match(page.warnings.join(' '), /sara has no login/);
});

test('a person without a login is taken where a login is only a record', async (t) => {
    // Device keys are how this deployment knows anybody: a tailnet login is a note beside
    // somebody's name rather than the way they are found, so it cannot be required.
    const { server, base } = await startTestServer({ ...WITH_PASSWORD, trustTailscaleHeaders: false });
    t.after(() => server.close());
    const { cookie } = await signIn(base, PASSWORD);

    const added = await addPerson(base, cookie, { id: 'sara', displayName: 'Sara' });
    assert.equal(added.status, 201, JSON.stringify(added.data));
    assert.equal(added.data.users.find((user) => user.id === 'sara').login, null,
        'no login is absent, not empty');

    const listed = await fetch(`${base}/api/admin/people`, { headers: { cookie: cookiePair(cookie) } });
    const page = await listed.json();
    assert.equal(page.requireLogins, false);
    assert.equal(page.people.find((person) => person.id === 'sara').login, '', 'and reads as nothing to show');

    // Two of them, which is the case a single empty string could never have expressed.
    assert.equal((await addPerson(base, cookie, { id: 'omar', displayName: 'Omar' })).status, 201);
    assert.equal(server.store.listUsers().filter((user) => user.login === null).length, 2);
    assert.equal(server.store.userByLogin('sara'), null, 'nobody is found by a login they do not have');
});

test('a login can be taken off somebody who leaves the tailnet', async (t) => {
    const { server, base } = await startTestServer({ ...WITH_PASSWORD, trustTailscaleHeaders: false });
    t.after(() => server.close());
    const { cookie } = await signIn(base, PASSWORD);

    const cleared = await fetch(`${base}/api/admin/people/dad`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookiePair(cookie) },
        body: JSON.stringify({ tailscaleLogin: '' }),
    });
    assert.equal(cleared.status, 200, JSON.stringify(await cleared.json().catch(() => ({}))));
    assert.equal(server.store.userByLogin('dad@dev'), null);
    assert.ok(server.store.userById('dad'), 'they keep their identity and their history');
});

/** A device key, as a client makes one: P-256, as the SPKI DER a server can read. */
function deviceKey() {
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

test('the console decides who can reach whom, and a call follows it', async (t) => {
    // A deployment that recognises nobody by where they are connecting from. This is the
    // case the directory file is the only source of contacts; where a proxy names the
    // caller, arriving makes people mutually visible and masks how thin this is.
    const { server, base } = await startTestServer({
        ...WITH_PASSWORD,
        networkMode: 'public',
        trustTailscaleHeaders: false,
        allowDevIdentity: false,
        requireDeviceAuth: true,
    });
    t.after(() => server.close());

    const cookie = cookiePair((await signIn(base, PASSWORD)).cookie);
    const asOperator = async (route, body) => {
        const response = await fetch(`${base}${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify(body ?? {}),
        });
        return { status: response.status, data: await response.json().catch(() => ({})) };
    };

    /** Somebody arrives the way they really do: a device, from an invitation. */
    async function arrive(userId) {
        const invitation = auth.createInvitation({
            store: server.store, config: server.config, now: new Date().toISOString(), userId,
        });
        const enrolled = await api(base, null, '/api/auth/enroll', {
            method: 'POST',
            body: {
                token: invitation.token,
                publicKey: deviceKey().publicKey,
                algorithm: 'ES256',
                deviceName: 'Test iPhone',
                platform: 'ios',
            },
        });
        assert.equal(enrolled.status, 200, JSON.stringify(enrolled.data));
        return enrolled.data.session.token;
    }

    const abdullah = await arrive('abdullah');
    await arrive('dad');
    const sees = async (token) => (await api(base, null, '/api/bootstrap', {
        headers: { authorization: `Bearer ${token}` },
    })).data.contacts.map((contact) => contact.id).sort();

    assert.deepEqual(await sees(abdullah), ['dad'], 'the fixture pairs them, and Dad has arrived');

    // Taking the pair away is not hiding somebody: it stops the call.
    assert.equal((await asOperator('/api/admin/contacts/remove', { ownerId: 'abdullah', contactId: 'dad' })).status, 200);
    assert.deepEqual(await sees(abdullah), [], 'and the app reads as empty, which is the report this came from');

    const refused = await api(base, null, '/api/calls', {
        method: 'POST',
        headers: { authorization: `Bearer ${abdullah}` },
        body: { inviteeIds: ['dad'] },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.data.error.code, 'CONTACT_NOT_ALLOWED');

    // And back again, which is what ticking the box does.
    assert.equal((await asOperator('/api/admin/contacts', { ownerId: 'abdullah', contactId: 'dad' })).status, 200);
    assert.deepEqual(await sees(abdullah), ['dad']);
});

test('everybody can reach everybody, and somebody who has never signed in is still unseen', async (t) => {
    const { server, base } = await startTestServer(WITH_PASSWORD);
    t.after(() => server.close());
    const { cookie } = await signIn(base, PASSWORD);
    const asOperator = async (route, body) => {
        const response = await fetch(`${base}${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: cookiePair(cookie) },
            body: JSON.stringify(body ?? {}),
        });
        return { status: response.status, data: await response.json().catch(() => ({})) };
    };

    const opened = await asOperator('/api/admin/contacts/everyone');
    assert.equal(opened.status, 200, JSON.stringify(opened.data));

    // Three people, both directions each: the graph is complete before the arrival filter
    // is applied, which is a different thing from everybody being visible.
    assert.equal(opened.data.contacts.length, 6);

    const listed = await fetch(`${base}/api/admin/people`, { headers: { cookie: cookiePair(cookie) } });
    const page = await listed.json();
    assert.ok(page.people.every((person) => !person.arrived), 'nobody has signed in on this server');
    assert.deepEqual(Object.keys(page.contacts[0]).sort(), ['contactId', 'ownerId', 'sortOrder']);
});
