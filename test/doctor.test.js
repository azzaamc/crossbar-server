'use strict';

// What the doctor asks about reachability, which is mode-dependent and was wrong in one of them.
//
// In private mode the check used to ask the server's own tailnet origin for https — from the box
// that is serving it. A deployment that was perfectly reachable therefore reported a failure, in
// the one command somebody runs when nothing works. What private mode can honestly ask is whether
// the server answers on the loopback listener that `tailscale serve` publishes, which is the same
// question a caller on the tailnet is asking.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { diagnose, checkDataParent, checkDuplicateSettings, checkPublicBindAddress } = require('../src/diagnostics');

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-doctor-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** Enough of a configuration for the doctor to answer about, and nothing else. */
function configuration(dir, overrides = {}) {
    return {
        networkMode: 'private',
        publicHostname: 'house.tailnet.ts.net',
        publicOrigin: 'https://house.tailnet.ts.net',
        host: '127.0.0.1',
        port: 0,
        dataDir: dir,
        directoryConfigPath: path.join(dir, 'directory.json'),
        sessionSecret: 'a-secret-long-enough-to-count',
        requireDeviceAuth: false,
        signalPath: '/api/signal',
        iceServers: [],
        turn: { host: '', port: 3478, minPort: 49160, maxPort: 49200, sharedSecret: '', ttlSeconds: 600 },
        envFile: path.join(dir, '.env'),
        ...overrides,
    };
}

function names(results) { return results.map((result) => result.name); }
function find(results, name) { return results.find((result) => result.name === name); }

test('in private mode the doctor asks the listener, not the tailnet name the box is serving', async (t) => {
    const dir = scratch(t);
    fs.writeFileSync(path.join(dir, 'directory.json'), JSON.stringify({
        users: [{ id: 'abdullah', tailscaleLogin: 'abdullah@dev', displayName: 'Abdullah', admin: true }],
        contacts: [],
        groups: [],
    }));

    // A server answering on the loopback listener, which is what private mode's check is about.
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'private', version: '0.1.0' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const port = server.address().port;

    const results = await diagnose({ config: configuration(dir, { port }) });

    assert.ok(names(results).includes('Server answering'),
        `private mode asks whether the server answers; it asked: ${names(results).join(', ')}`);
    assert.equal(find(results, 'Server answering').ok, true,
        'and the answer is yes when a server is listening on that listener');
    assert.ok(!names(results).includes('HTTPS'),
        'it does not ask its own tailnet origin for https, which no box can answer about itself');
});

test('in public mode the doctor asks the public origin, where the question has an outside', async (t) => {
    const dir = scratch(t);
    fs.writeFileSync(path.join(dir, 'directory.json'), JSON.stringify({
        users: [{ id: 'abdullah', tailscaleLogin: 'abdullah@dev', displayName: 'Abdullah', admin: true }],
        contacts: [],
        groups: [],
    }));

    // 127.0.0.1 as the hostname keeps this fast: it resolves, and its TLS refusal is immediate.
    const results = await diagnose({
        config: configuration(dir, { networkMode: 'public', publicHostname: '127.0.0.1', publicOrigin: 'https://127.0.0.1' }),
    });

    assert.ok(names(results).includes('HTTPS'), 'public mode asks the origin people reach it at');
    assert.ok(!names(results).includes('Server answering'), 'and not the private-mode question');
    assert.deepEqual(names(results).filter((name) => ['DNS', 'TLS certificate', 'HTTPS', 'WebSocket'].includes(name)),
        ['DNS', 'TLS certificate', 'HTTPS', 'WebSocket'],
        'the whole public path is asked about, in the order it is walked');
});

// ── The three the .env and the tree get wrong ───────────────────────────────────
//
// Each of these was measured on the live deployment, 2026-09-26, and each fails somewhere other
// than where it is: a second line for a name that is already set is dead and the setting it was
// meant to change never takes effect, a wildcard public bind address is a certificate that never
// appears, and a `tar` built on macOS leaves a tree whose uid this host has no account for, after
// which every `.env` write fails. The doctor asks about each on its own line, for the reason the
// file's own header gives: "the setting is wrong" is not something an operator can act on.

test('a name set twice is reported with both lines, and the first is the one in force', (t) => {
    const dir = scratch(t);
    const config = configuration(dir);
    fs.writeFileSync(config.envFile, [
        '# the public block',                             // 1, a comment is not a setting
        'CROSSBAR_NETWORK_MODE=public',                   // 2
        'NETWORK_MODE_PUBLIC_BIND_ADDRESS=203.0.113.7',   // 3
        'HOST=127.0.0.1',                                 // 4
        'NETWORK_MODE_PUBLIC_BIND_ADDRESS=',              // 5, appended below a line that won
        'HOST=127.0.0.1',                                 // 6
        'NETWORK_MODE_PUBLIC_BIND_ADDRESS=198.51.100.9',  // 7
    ].join('\n') + '\n');

    const reported = checkDuplicateSettings(config);
    assert.equal(reported.ok, true, 'a line that does nothing is a warning, not a failure');
    assert.equal(reported.warn, true);
    assert.match(reported.detail, /2 names set more than once/);
    assert.match(reported.detail, /NETWORK_MODE_PUBLIC_BIND_ADDRESS, on lines 3, 5 and 7/);
    assert.match(reported.detail, /HOST, on lines 4 and 6/);
    assert.match(reported.detail, /Only the first of each is in force/);

    // Which is the fault the warning exists for: the value in force is the first line, so the
    // line the operator appended last of all is the one with nothing behind it.
    assert.match(checkPublicBindAddress(config).detail, /203\.0\.113\.7/);
});

test('a wildcard public bind address is refused, because tailscaled already holds 0.0.0.0:443', (t) => {
    const dir = scratch(t);
    const config = configuration(dir, { networkMode: 'public' });

    for (const value of ['0.0.0.0', '::', '']) {
        fs.writeFileSync(config.envFile, `CROSSBAR_NETWORK_MODE=public\nNETWORK_MODE_PUBLIC_BIND_ADDRESS=${value}\n`);
        const refused = checkPublicBindAddress(config);
        assert.equal(refused.ok, false, `${value || 'empty'} is every address, not the one this is reached at`);
        assert.match(refused.detail, /tailscaled already holds 0\.0\.0\.0:443 in public mode/);
        assert.match(refused.detail, /so Caddy never obtains a certificate/);
        assert.match(refused.detail, /It must name the address this deployment is reached at\./);
    }

    // Not set at all is the same fault by another route: nothing names an address for Caddy to
    // bind, so it takes them all, exactly as it does for the three above.
    fs.writeFileSync(config.envFile, 'CROSSBAR_NETWORK_MODE=public\n');
    const unset = checkPublicBindAddress(config);
    assert.equal(unset.ok, false);
    assert.match(unset.detail, /is not set, so nothing names an address at all/);

    // The address the deployment is reached at is what passes.
    fs.writeFileSync(config.envFile, 'CROSSBAR_NETWORK_MODE=public\nNETWORK_MODE_PUBLIC_BIND_ADDRESS=203.0.113.7\n');
    assert.equal(checkPublicBindAddress(config).ok, true);

    // And a box with no `.env` at all is not a box this check can read an address out of: the
    // doctor says so rather than inventing a fault about a file that is not there.
    fs.rmSync(config.envFile);
    const absent = checkPublicBindAddress(config);
    assert.equal(absent.ok, true);
    assert.match(absent.detail, /no \.env beside this process/);
});

test('a data parent owned by a uid no account on this host claims is a failure', (t) => {
    const dir = scratch(t);
    const config = configuration(dir, { dataDir: path.join(dir, 'data') });

    // What a `tar` built on another machine leaves: mode 0700 under an owner this host has never
    // heard of, so the write and the traverse stay with an account that cannot log in. The stat
    // is handed in because making a real directory be owned by a uid that does not exist needs
    // root — the same way `checkTailscale` is handed the command it should run.
    const stranger = () => ({ uid: 70000, gid: 70000, mode: 0o040700 });
    const noAccount = () => null;

    const reported = checkDataParent(config, stranger, noAccount);
    assert.equal(reported.ok, false, 'an owner nobody can be is a parent nothing can be written under');
    assert.equal(reported.warn, undefined);
    assert.match(reported.detail, /owned by uid 70000, which this host has no account for/);
    assert.match(reported.detail, /mode 0700/);
    assert.match(reported.detail, /nothing but root may write there/);
    assert.match(reported.detail, /Read the owner, the mode and the group, not a writability test/);

    // The same owner, resolvable, is passed: which account runs the service is not something the
    // doctor is told, and claiming to have tested it would fail every tree that belongs to root.
    const named = checkDataParent(config, stranger, () => 'admin');
    assert.equal(named.ok, true);
    assert.match(named.detail, /owned by admin \(mode 0700, group gid 70000\)/);
    assert.match(named.detail, /read rather than tested for writability/);

    // A host that cannot be asked has not answered no: with no `id` to run, the question was
    // never put, and that is what the line says.
    const unaskable = checkDataParent(config, stranger, () => undefined);
    assert.equal(unaskable.ok, true);
    assert.match(unaskable.detail, /the id command is not runnable/);

    // And the ordinary answer, read off a real directory with the real lookup: the account that
    // owns it, which on every host running this suite is one that exists.
    const real = checkDataParent(config);
    assert.ok(real.detail.startsWith(`${dir} is owned by `), `a real tree is owned by an account: ${real.detail}`);
    assert.equal(real.ok, true);
});

test('the doctor asks the new questions in the mode each belongs to', async (t) => {
    const dir = scratch(t);
    fs.writeFileSync(path.join(dir, 'directory.json'), JSON.stringify({
        users: [{ id: 'abdullah', tailscaleLogin: 'abdullah@dev', displayName: 'Abdullah', admin: true }],
        contacts: [],
        groups: [],
    }));
    const config = configuration(dir);
    fs.writeFileSync(config.envFile, 'CROSSBAR_NETWORK_MODE=public\nNETWORK_MODE_PUBLIC_BIND_ADDRESS=0.0.0.0\n');

    // In private mode the public block is not the configuration in force: a wildcard in it is
    // dormant, and reporting it would be a warning about a front door this deployment never opens.
    const privateResults = await diagnose({ config });
    assert.ok(!names(privateResults).includes('Public bind address'),
        'private mode does not ask about the address public mode binds');
    for (const name of ['Data directory parent', 'Duplicate settings']) {
        assert.ok(names(privateResults).includes(name), `the doctor asks about the ${name}`);
        assert.equal(find(privateResults, name).ok, true);
    }

    // In public mode it is the address Caddy binds, and it is reported as the failure it is.
    const publicResults = await diagnose({
        config: configuration(dir, { networkMode: 'public', publicHostname: '127.0.0.1', publicOrigin: 'https://127.0.0.1' }),
    });
    const asked = find(publicResults, 'Public bind address');
    assert.ok(asked, `public mode asks about the bind address; it asked: ${names(publicResults).join(', ')}`);
    assert.equal(asked.ok, false);
    assert.match(asked.detail, /0\.0\.0\.0/);
});

test('a healthy tree and a healthy .env leave all three checks with nothing to say', (t) => {
    const dir = scratch(t);
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const config = configuration(dir, { dataDir });
    fs.writeFileSync(config.envFile, [
        'CROSSBAR_NETWORK_MODE=public',
        'NETWORK_MODE_PUBLIC_HOSTNAME=box.example',
        'NETWORK_MODE_PUBLIC_BIND_ADDRESS=203.0.113.7',
    ].join('\n') + '\n');

    for (const result of [checkDataParent(config), checkDuplicateSettings(config), checkPublicBindAddress(config)]) {
        assert.equal(result.ok, true, `${result.detail} is not a fault`);
        assert.equal(result.warn, undefined, `${result.detail} is not a warning either`);
    }
});
