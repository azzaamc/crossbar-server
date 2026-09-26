'use strict';

// A mode switch, end to end: the CLI rewrites the file, the server is started the way a
// deployment starts it, and both modes are asked what they believe.
//
// Everything else about a switch is a unit test of a pure function over a string. This is the
// only place the two halves meet, which makes it the only place that can catch the class of bug
// a switch is actually prone to: the file saying one thing while the running server does
// another. The trust posture is the thing being checked, not the text -- a public deployment
// that still believed the identity header would be a deployment anybody on the internet could
// be.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SERVER = path.resolve(__dirname, '..');

/** A port nothing is listening on, asked of the kernel rather than guessed. */
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-switch-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/**
 * A first-run directory and a `.env` holding both mode blocks, with values that differ so a
 * switch that leaves one behind is visible. No line outside the blocks names a generated key:
 * a deployment writes those through the mode, and the switch refuses rather than deleting one.
 */
function instance(t, port) {
    const dir = scratch(t);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'directory.json'), JSON.stringify({
        users: [
            { id: 'abdullah', tailscaleLogin: 'abdullah@dev', displayName: 'Abdullah', admin: true },
            { id: 'nadia', tailscaleLogin: 'nadia@dev', displayName: 'Nadia' },
        ],
        contacts: [
            { ownerId: 'abdullah', contactId: 'nadia', sortOrder: 0 },
            { ownerId: 'nadia', contactId: 'abdullah', sortOrder: 0 },
        ],
        groups: [],
    }, null, 2));
    fs.writeFileSync(path.join(dir, '.env'), [
        'NODE_ENV=production',
        'HOST=127.0.0.1',
        `PORT=${port}`,
        `DATA_DIR=${dir}/data`,
        `DIRECTORY_CONFIG_PATH=${dir}/data/directory.json`,
        'CROSSBAR_SESSION_SECRET=scratch-secret-long-enough-to-be-believed',
        '# A comment and a setting that have nothing to do with the mode, and must survive one.',
        'CROSSBAR_SESSION_TTL_SECONDS=43200',
        'NETWORK_MODE_PRIVATE_HOSTNAME=house.tailnet.ts.net',
        'NETWORK_MODE_PRIVATE_ORIGIN=https://house.tailnet.ts.net:8443',
        'NETWORK_MODE_PRIVATE_BIND_ADDRESS=',
        'NETWORK_MODE_PUBLIC_HOSTNAME=calls.example.com',
        'NETWORK_MODE_PUBLIC_ORIGIN=https://calls.example.com',
        'NETWORK_MODE_PUBLIC_BIND_ADDRESS=127.0.0.1',
        '',
    ].join('\n'));
    return dir;
}

function switchTo(dir, mode) {
    const result = spawnSync(process.execPath, [path.join(SERVER, 'src', 'admin.js'), 'mode', mode],
        { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, `the switch refused: ${result.stdout}${result.stderr}`);
    return result.stdout;
}

/** The file as a switch leaves it, split into what a switch owns and what it must not touch. */
function readEnv(dir) {
    const lines = fs.readFileSync(path.join(dir, '.env'), 'utf8').split('\n');
    const begin = lines.findIndex((line) => line.startsWith('# >>> the configuration in force'));
    const end = lines.findIndex((line) => line.startsWith('# <<< end of the configuration'));
    // A file no switch has written yet has no generated section. Everything in it is then
    // "outside", which is what the first reading of a fixture is for: the comparison that
    // matters is that the outside lines are the same before and after.
    if (begin === -1 || end <= begin) return { generated: '', outside: lines.filter(Boolean), all: lines.join('\n') };
    return {
        generated: lines.slice(begin, end + 1).join('\n'),
        outside: [...lines.slice(0, begin), ...lines.slice(end + 1)].filter(Boolean),
        all: lines.join('\n'),
    };
}

async function startServer(dir, port) {
    const child = spawn(process.execPath, [path.join(SERVER, 'src', 'server.js')], {
        cwd: dir,
        // A bare environment, the way a unit's EnvironmentFile gives one: nothing inherited
        // from the runner can quietly win over the file, which is how a switch appears to do
        // nothing while the server keeps its old settings.
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        try {
            const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
                signal: AbortSignal.timeout(1_000),
            });
            if (response.ok) return { child, output: () => output };
        } catch { /* not listening yet */ }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    child.kill('SIGKILL');
    throw new Error(`the server did not answer: ${output}`);
}

function ask(port, pathname, headers = {}) {
    return fetch(`http://127.0.0.1:${port}${pathname}`, { headers }).then(async (response) => ({
        status: response.status,
        data: await response.json().catch(() => ({})),
    }));
}

/** The header a Tailscale Serve puts in front of a request from the tailnet. */
const AS_A_TAILNET_MEMBER = {
    'Tailscale-User-Login': 'nadia@dev',
    'Tailscale-User-Name': 'Nadia',
};

test('a switch changes what the server believes, and the file is the only thing that moves', async (t) => {
    const port = await freePort();
    const dir = instance(t, port);
    const before = readEnv(dir);

    // ── public: the public hostname is the way in, and an identity header is not one ──────
    switchTo(dir, 'public');
    const asPublic = readEnv(dir);
    assert.match(asPublic.generated, /^CROSSBAR_NETWORK_MODE=public$/m);
    assert.match(asPublic.generated, /^CROSSBAR_PUBLIC_HOSTNAME=calls\.example\.com$/m);
    assert.deepEqual(asPublic.outside, before.outside,
        'nothing outside the generated section is touched by a switch');

    const publicServer = await startServer(dir, port);
    t.after(() => publicServer.child.kill('SIGKILL'));
    const publicHealth = await ask(port, '/api/health');
    assert.equal(publicHealth.data.mode, 'public');
    assert.match(publicHealth.data.version, /^\d+\.\d+\.\d+$/);

    // Somebody on the network claiming to be a person is not a person here: in public mode the
    // header is not believed at all, so a request with it is as anonymous as one without.
    const publicClaim = await ask(port, '/api/session', AS_A_TAILNET_MEMBER);
    assert.equal(publicClaim.data.authenticated, false,
        'a public deployment must not believe the identity header');
    const publicBootstrap = await ask(port, '/api/bootstrap', AS_A_TAILNET_MEMBER);
    assert.equal(publicBootstrap.data.error?.code, 'DEVICE_AUTH_REQUIRED',
        'public mode asks for a device key, not a header');
    publicServer.child.kill('SIGTERM');

    // ── private: the tailnet is the way in, and the same header is believed ───────────────
    switchTo(dir, 'private');
    const asPrivate = readEnv(dir);
    assert.match(asPrivate.generated, /^CROSSBAR_NETWORK_MODE=private$/m);
    assert.match(asPrivate.generated, /^CROSSBAR_PUBLIC_HOSTNAME=house\.tailnet\.ts\.net$/m,
        "the private block's own hostname is written under the name everything reads");
    assert.deepEqual(asPrivate.outside, before.outside,
        'a switch back touches nothing outside the generated section either');

    const privateServer = await startServer(dir, port);
    t.after(() => privateServer.child.kill('SIGKILL'));
    const privateHealth = await ask(port, '/api/health');
    assert.equal(privateHealth.data.mode, 'private');

    const abdullah = { 'Tailscale-User-Login': 'abdullah@dev', 'Tailscale-User-Name': 'Abdullah' };

    // Before she has been here at all, the directory already says the two of them may reach each
    // other — and she is offered to nobody, because being written down is not the same as having
    // arrived. This is the rule that keeps an invitation from being a name in a list.
    const beforeArrival = await ask(port, '/api/bootstrap', abdullah);
    assert.deepEqual(beforeArrival.data.contacts.map((c) => c.id), []);

    const privateClaim = await ask(port, '/api/session', AS_A_TAILNET_MEMBER);
    assert.equal(privateClaim.data.authenticated, true,
        'a private deployment is reached only through the network that supplies this header');
    assert.equal(privateClaim.data.identity?.source, 'tailscale');

    const privateBootstrap = await ask(port, '/api/bootstrap', abdullah);
    assert.equal(privateBootstrap.status, 200);
    assert.deepEqual(privateBootstrap.data.contacts.map((c) => c.id), ['nadia'],
        'the pair written in the directory is the pair the app is given');
    privateServer.child.kill('SIGTERM');
});
