'use strict';

// What this software knows and cannot show.
//
// Three questions an operator can only answer from outside the running process: who is in
// the database that the directory file does not name, which build is answering, and what a
// `.env` says that this build does not read — plus the preflight a first install needs
// before any of it can be asked. Every test here fails if the behaviour it describes is
// taken away.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { startTestServer, api } = require('./helpers');
const { unreadEnvKeys } = require('../src/config');
const diagnostics = require('../src/diagnostics');

const VERSION = require('../package.json').version;
const EXAMPLE_ENV = path.join(__dirname, '..', '.env.example');
const DEVELOPER_ENV = path.join(__dirname, '..', '.env');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-visibility-'));

/** A directory file, with or without somebody who can administer it. */
function writeDirectory(filePath, { admin = true } = {}) {
    const person = { id: 'abdullah', tailscaleLogin: 'abdullah@dev', displayName: 'Abdullah', avatar: '' };
    if (admin) person.admin = true;
    fs.writeFileSync(filePath, JSON.stringify({ users: [person], contacts: [] }));
}

/** What the individual checks read. Nothing here opens a server or a database. */
function configFor(dir, overrides = {}) {
    return {
        host: '127.0.0.1',
        port: 0,
        publicOrigin: 'http://127.0.0.1:1',
        publicHostname: '',
        networkMode: 'private',
        dataDir: path.join(dir, 'data'),
        directoryConfigPath: path.join(dir, 'directory.json'),
        envFile: path.join(dir, '.env'),
        iceServers: [],
        turn: { host: '' },
        sessionSecret: '',
        requireDeviceAuth: false,
        signalPath: '/socket.io/',
        ...overrides,
    };
}

/** A port nothing is listening on, which is closed again before it is returned. */
async function freePort() {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

// ── People the file does not name ───────────────────────────────────────────────

test('a person the file does not name is listed as unlisted, and one in the file is not', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    // A tailnet identity nobody wrote into the file. Private mode mints a person for it,
    // which is what leaves somebody in the database and out of the file this console edits.
    const arrived = await api(base, null, '/api/session', {
        headers: { 'Tailscale-User-Login': 'someone@example.com', 'Tailscale-User-Name': 'Someone' },
    });
    assert.equal(arrived.status, 200);
    assert.equal(arrived.data.authenticated, true);
    assert.equal(arrived.data.configured, true, 'the identity was enrolled as a person');

    const { status, data } = await api(base, 'abdullah@dev', '/api/admin/people');
    assert.equal(status, 200);
    // The file's people, and only them.
    assert.deepEqual(data.people.map((person) => person.id).sort(), ['abdullah', 'dad', 'mum']);

    assert.equal(data.unlisted.length, 1);
    const [person] = data.unlisted;
    assert.match(person.id, /^ts_[0-9a-f]{24}$/, 'the id is derived from the login, not from the file');
    assert.equal(person.displayName, 'Someone');
    assert.equal(person.login, 'someone@example.com');
    assert.equal(person.devices, 0);
    assert.ok(person.firstSeen, 'when they arrived is what says they arrived at all');
    assert.equal(person.lastAuthenticated, person.firstSeen);
    assert.equal(person.takenOutOfTheFile, false);
});

test('somebody taken out of the file is reported as taken out of it, not as an arrival', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    const removed = await api(base, 'abdullah@dev', '/api/admin/people/dad/remove', { method: 'POST' });
    assert.equal(removed.status, 200);

    const { data } = await api(base, 'abdullah@dev', '/api/admin/people');
    assert.deepEqual(data.people.map((person) => person.id).sort(), ['abdullah', 'mum']);
    const person = data.unlisted.find((item) => item.id === 'dad');
    assert.ok(person, 'the row the file stopped naming is still visible, because it is still there');
    assert.equal(person.login, 'dad@dev');
    assert.equal(person.takenOutOfTheFile, true);
});

// ── Which build is running ──────────────────────────────────────────────────────

test('the status answer carries the version of the process that is answering', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    const status = await api(base, 'abdullah@dev', '/api/admin/status');
    assert.equal(status.status, 200);
    assert.equal(status.data.version, VERSION);

    // The same version the unauthenticated health route gives: one process, one build, and
    // the console's Server card is where an operator looks for it.
    const health = await api(base, null, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.version, VERSION);
});

// ── Names nothing reads ─────────────────────────────────────────────────────────

test('a name in .env that nothing reads is reported, with the name probably meant', () => {
    const unread = unreadEnvKeys([
        'CROSSBAR_SESSION_SECERT=something',
        'CROSSBAR_SESSION_SECRET=something',
        'DATA_DIR=./data',
        'HOST=127.0.0.1',
    ].join('\n'));
    assert.deepEqual(unread, [{ key: 'CROSSBAR_SESSION_SECERT', suggestion: 'CROSSBAR_SESSION_SECRET' }]);

    // Nothing close enough to be worth naming gets no suggestion rather than a wrong one, and
    // a name that is not this project's is not reported at all — `HOST` and `PATH` belong to
    // other tools, and a warning they raise is a warning learned to be ignored.
    assert.deepEqual(unreadEnvKeys('CROSSBAR_SOMETHING_ELSE=1\nSHELL=/bin/sh\n'), [
        { key: 'CROSSBAR_SOMETHING_ELSE', suggestion: null },
    ]);

    // Comments and blanks are not names, exactly as `loadDotEnv` reads them.
    assert.deepEqual(unreadEnvKeys('# CROSSBAR_SESSION_SECERT=not-a-setting\n\n'), []);
});

test('every name the documented files set is one this server reads', () => {
    // The example file ships to operators and the developer's own file is what this machine
    // runs; a name in either that nothing reads is either a typo in the file or a setting
    // added to the server and never declared. Both are the failure this list exists for.
    for (const file of [EXAMPLE_ENV, DEVELOPER_ENV]) {
        assert.deepEqual(unreadEnvKeys(fs.readFileSync(file, 'utf8')), [],
            `${path.basename(file)} names something nothing reads`);
    }
});

test('the doctor warns about an unread name and does not fail on it', (t) => {
    const dir = scratch();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const config = configFor(dir);

    fs.writeFileSync(config.envFile, 'CROSSBAR_NETWORK_MODE=private\nCROSSBAR_SESSION_SECERT=oops\n');
    const warned = diagnostics.checkEnvFile(config);
    assert.equal(warned.ok, true, 'a warning is not a failure');
    assert.equal(warned.warn, true);
    assert.match(warned.detail, /CROSSBAR_SESSION_SECERT, did you mean CROSSBAR_SESSION_SECRET\?/);

    fs.writeFileSync(config.envFile, 'CROSSBAR_SESSION_SECRET=fine\nHOST=127.0.0.1\nCROSSBAR_NETWORK_MODE=private\n');
    const quiet = diagnostics.checkEnvFile(config);
    assert.equal(quiet.ok, true);
    assert.equal(quiet.warn, undefined, 'a file everything reads, that says its mode, is not warned about');
    assert.match(quiet.detail, /every name in \.env is one this server reads/);

    // And what a warning means to the exit code: counted, and never a failure.
    assert.deepEqual(diagnostics.summariseResults([warned]), { failed: 0, warned: 1, checked: 1 });
    assert.deepEqual(diagnostics.summariseResults([warned, { name: 'x', ok: false, detail: '' }]),
        { failed: 1, warned: 1, checked: 2 });
});

test('a file that does not say which mode it is in is warned about, because a unit greps for it', (t) => {
    const dir = scratch();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const config = configFor(dir);
    // `deploy/.env.example` before any switch: both mode blocks, no generated section. The mode
    // is in force by default, so nothing inside this process notices — the front doors' units
    // do, and on a fresh install that means nothing ever configures one.
    fs.writeFileSync(config.envFile, 'HOST=127.0.0.1\nNETWORK_MODE_PRIVATE_HOSTNAME=box.tailnet.ts.net\n');
    const warned = diagnostics.checkEnvFile(config);
    assert.equal(warned.ok, true);
    assert.equal(warned.warn, true);
    assert.match(warned.detail, /does not say which mode it is in/);
    assert.match(warned.detail, /CROSSBAR_NETWORK_MODE/);
    assert.match(warned.detail, /node src\/admin\.js mode private/);
});

// ── The first-install preflight ─────────────────────────────────────────────────

test('the directory file has to be there, parse, and name an administrator', (t) => {
    const dir = scratch();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const config = configFor(dir);

    assert.throws(() => diagnostics.checkDirectoryFile(config), /No directory file at/);

    fs.writeFileSync(config.directoryConfigPath, '{ not json');
    assert.throws(() => diagnostics.checkDirectoryFile(config), SyntaxError);

    fs.writeFileSync(config.directoryConfigPath, JSON.stringify({ users: [], contacts: [] }));
    assert.throws(() => diagnostics.checkDirectoryFile(config), /at least one person/);

    writeDirectory(config.directoryConfigPath, { admin: false });
    assert.throws(() => diagnostics.checkDirectoryFile(config), /needs an administrator/);

    writeDirectory(config.directoryConfigPath);
    assert.deepEqual(diagnostics.checkDirectoryFile(config),
        { ok: true, detail: '1 person, 1 administrator' });
});

test('a data directory that cannot be written is a failure that says so', (t) => {
    const dir = scratch();
    t.after(() => {
        fs.chmodSync(dir, 0o700);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // Nothing there yet is not a fault: the store creates it, and the report says it did.
    const config = configFor(dir);
    assert.deepEqual(diagnostics.checkDataDir(config), { ok: true, detail: `${config.dataDir} did not exist; created it` });
    assert.deepEqual(diagnostics.checkDataDir(config), { ok: true, detail: `${config.dataDir} is writable` });

    // A directory that exists and cannot be written is: the database and the backups live
    // there, and the permission is the whole of the fault.
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked, { mode: 0o500 });
    fs.chmodSync(locked, 0o500);
    assert.throws(() => diagnostics.checkDataDir(configFor(dir, { dataDir: locked })), { code: 'EACCES' });
});

test('the listener is free, held by us, or held by somebody else', async (t) => {
    const dir = scratch();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    // Held by something that answers, but not as Crossbar: the request reaches a server and
    // the answer is not the one this deployment's own health route gives.
    const squatter = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'something-else' }));
    });
    await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    t.after(() => squatter.close());

    const taken = await diagnostics.checkListener(configFor(dir, { port: squatter.address().port }));
    assert.equal(taken.ok, false);
    assert.match(taken.detail, /held by something that is not this deployment/);

    // Held by a Crossbar server, which is the healthy answer on a box that is running one:
    // `doctor` is run as often on a live deployment as on a new one.
    const { server, port } = await startTestServer();
    t.after(() => server.close());
    assert.deepEqual(await diagnostics.checkListener(configFor(dir, { port })),
        { ok: true, detail: `127.0.0.1:${port} is held by a Crossbar server` });

    const free = await freePort();
    assert.deepEqual(await diagnostics.checkListener(configFor(dir, { port: free })),
        { ok: true, detail: `127.0.0.1:${free} is free` });
});

test('private mode needs Tailscale serving the port this deployment listens on', (t) => {
    const dir = scratch();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const config = configFor(dir, { port: 3003 });

    const missing = diagnostics.checkTailscale(config, path.join(dir, 'no-such-command'));
    assert.deepEqual(missing,
        { ok: false, detail: 'the tailscale command is not runnable here, and this mode is reached through it' });

    const serving = path.join(dir, 'tailscale-serving');
    fs.writeFileSync(serving, [
        '#!/bin/sh',
        'case "$1" in',
        '  version) echo "1.60.0" ;;',
        '  serve) echo "https://box.tailnet.ts.net (tailnet only)"',
        '         echo "|-- / proxy http://127.0.0.1:3003" ;;',
        'esac',
        '',
    ].join('\n'), { mode: 0o755 });
    assert.deepEqual(diagnostics.checkTailscale(config, serving),
        { ok: true, detail: 'serving the loopback listener (port 3003)' });

    // Serving a *different* port is the fault this check exists for: the front door is
    // configured and points at nothing, which looks like the app failing rather than the box.
    const elsewhere = diagnostics.checkTailscale(configFor(dir, { port: 3010 }), serving);
    assert.equal(elsewhere.ok, false);
    assert.match(elsewhere.detail, /Tailscale is not serving port 3010/);

    const down = path.join(dir, 'tailscale-down');
    fs.writeFileSync(down, [
        '#!/bin/sh',
        'if [ "$1" = version ]; then echo "1.60.0" >&2; exit 0; fi',
        'echo "Tailscale is not running." >&2',
        'exit 1',
        '',
    ].join('\n'), { mode: 0o755 });
    const failed = diagnostics.checkTailscale(config, down);
    assert.equal(failed.ok, false);
    assert.match(failed.detail, /tailscale serve is not serving anything \(Tailscale is not running\.\)/);
});

test('public mode needs its name to resolve and its address to answer', async (t) => {
    const dir = scratch();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    // One reason: the name resolves to nothing, which is fixed at the registrar.
    const unresolved = await diagnostics.checkPublicIngress(configFor(dir, {
        networkMode: 'public',
        publicHostname: 'crossbar-does-not-exist.invalid',
        publicOrigin: 'https://crossbar-does-not-exist.invalid',
    }));
    assert.equal(unresolved.ok, false);
    assert.match(unresolved.detail, /crossbar-does-not-exist\.invalid does not resolve/);

    // The other: the name is fine and nothing answers, which is fixed in the firewall or in
    // whatever should be proxying. Told apart on purpose — "not reachable" says neither.
    const silent = await freePort();
    const nothing = await diagnostics.checkIngress('127.0.0.1', silent);
    assert.equal(nothing.ok, false);
    assert.match(nothing.detail, new RegExp(`127\\.0\\.0\\.1 resolves but nothing answers on ${silent}$`));

    const { server, port } = await startTestServer();
    t.after(() => server.close());
    assert.deepEqual(await diagnostics.checkIngress('127.0.0.1', port),
        { ok: true, detail: `127.0.0.1 resolves and ${port} answers` });
});

test('the doctor asks the first-install questions, and a missing database is one of them', async (t) => {
    const dir = scratch();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const config = configFor(dir, { port: await freePort() });
    fs.writeFileSync(config.envFile, 'CROSSBAR_SESSION_SECERT=oops\n');

    const results = await diagnostics.diagnose({ config });
    const byName = new Map(results.map((row) => [row.name, row]));
    for (const name of ['Directory file', 'Data directory', 'Listener', 'Tailscale', 'Configuration file']) {
        assert.ok(byName.has(name), `the doctor asks about the ${name}`);
    }
    assert.equal(byName.get('Directory file').ok, false);
    assert.match(byName.get('Directory file').detail, /No directory file at/);
    assert.equal(byName.get('Configuration file').ok, true);
    assert.equal(byName.get('Configuration file').warn, true);

    // A database that could not be opened is reported rather than thrown, and a warning
    // never makes the doctor fail — a missing directory file does.
    const withStore = await diagnostics.diagnose({ config, storeError: 'No directory file at /nowhere.json.' });
    const database = withStore.find((row) => row.name === 'Database');
    assert.deepEqual({ ...database }, { name: 'Database', ok: false, detail: 'No directory file at /nowhere.json.' });

    // Warnings are counted apart from failures, and a warning is never one of them.
    const { failed, warned } = diagnostics.summariseResults(results);
    assert.equal(warned, 1);
    assert.ok(failed >= 1, 'a directory file that is not there is a failure');
    assert.equal(results.filter((row) => row.warn).every((row) => row.ok), true);
});
