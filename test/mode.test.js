'use strict';

// The two configurations on one deployment: `.env` holds both, and one command moves
// between them. What is worth testing is that the command cannot leave a deployment
// unable to start — a switch that half-lands is worse than no switch at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { applyMode } = require('../src/config');

const ADMIN = path.join(__dirname, '..', 'src', 'admin.js');

const CONFIGURED = `# A deployment that holds both configurations.
HOST=127.0.0.1
PORT=3003

# The tailnet: a proxy injects the identity header.
NETWORK_MODE_PRIVATE_HOSTNAME=qatar-vpn.taile123.ts.net
NETWORK_MODE_PRIVATE_ORIGIN=https://qatar-vpn.taile123.ts.net

# The open internet: a reverse proxy terminates TLS on the address below.
NETWORK_MODE_PUBLIC_HOSTNAME=crossbar.example.com
NETWORK_MODE_PUBLIC_ORIGIN=https://crossbar.example.com
NETWORK_MODE_PUBLIC_BIND_ADDRESS=203.0.113.7

CROSSBAR_SESSION_SECRET=a-secret-that-must-survive
DATA_DIR=./data
FAMILY_CONFIG_PATH=./data/family.json
`;

/** A deployment directory holding only what the switch reads and writes. */
function deployment(env) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-mode-'));
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    const household = JSON.stringify({
        users: [{ id: 'one', tailscaleLogin: 'one@dev', displayName: 'One', avatar: '' }],
        contacts: [],
        groups: [],
    });
    fs.writeFileSync(path.join(dir, 'data', 'family.json'), household);
    fs.writeFileSync(path.join(dir, '.env'), env);
    return dir;
}

const envFile = (dir) => fs.readFileSync(path.join(dir, '.env'), 'utf8');

// Spawned with nothing but a PATH, so the test's own process — which loaded this
// repository's `.env` when it required the config — cannot leak into the deployment.
const admin = (dir, ...args) => spawnSync(process.execPath, [ADMIN, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
});

test('switching writes that mode, and leaves the rest of the file alone', () => {
    const content = applyMode(CONFIGURED, 'public');
    assert.match(content, /^CROSSBAR_NETWORK_MODE=public$/m);
    assert.match(content, /^PUBLIC_ORIGIN=https:\/\/crossbar\.example\.com$/m);
    assert.match(content, /^CROSSBAR_BIND_ADDRESS=203\.0\.113\.7$/m);
    // Settings that are not the mode's business are not the switch's business.
    assert.match(content, /^CROSSBAR_SESSION_SECRET=a-secret-that-must-survive$/m);
    assert.match(content, /^DATA_DIR=\.\/data$/m);
});

test('the name is the switch\'s wherever else it appears, so a stale line cannot win', () => {
    const stale = 'TRUST_TAILSCALE_HEADERS=true\nCROSSBAR_REQUIRE_DEVICE_AUTH=true\nDATA_DIR=./data\n';
    const content = applyMode(stale, 'public');
    assert.equal(content.match(/^TRUST_TAILSCALE_HEADERS=/gm).length, 1);
    assert.match(content, /^TRUST_TAILSCALE_HEADERS=$/m);
    assert.match(content, /^CROSSBAR_REQUIRE_DEVICE_AUTH=$/m);
    assert.match(content, /^DATA_DIR=\.\/data$/m);
});

test('switching to the mode already written changes nothing', () => {
    const once = applyMode(CONFIGURED, 'public');
    assert.equal(applyMode(once, 'public'), once);
});

test('a switch lands the mode it was asked for, and the file says so', () => {
    const dir = deployment(CONFIGURED);
    const result = admin(dir, 'mode', 'public');
    assert.equal(result.status, 0, result.stderr);
    assert.match(envFile(dir), /^CROSSBAR_NETWORK_MODE=public$/m);
    assert.match(envFile(dir), /^PUBLIC_ORIGIN=https:\/\/crossbar\.example\.com$/m);
});

test('switching back takes the other mode\'s own address', () => {
    const dir = deployment(CONFIGURED);
    admin(dir, 'mode', 'public');
    const result = admin(dir, 'mode', 'private');
    assert.equal(result.status, 0, result.stderr);
    assert.match(envFile(dir), /^CROSSBAR_NETWORK_MODE=private$/m);
    assert.match(envFile(dir), /^PUBLIC_ORIGIN=https:\/\/qatar-vpn\.taile123\.ts\.net$/m);
});

test('a mode that is not configured is refused, and the file is left as it was', () => {
    const dir = deployment(CONFIGURED.replace(/^NETWORK_MODE_PUBLIC_HOSTNAME=.*$/m, ''));
    const before = envFile(dir);
    const result = admin(dir, 'mode', 'public');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /NETWORK_MODE_PUBLIC_HOSTNAME/);
    assert.equal(envFile(dir), before);
});

test('with no argument it shows both, and which one is in force', () => {
    const dir = deployment(CONFIGURED);
    const result = admin(dir, 'mode');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /private/);
    assert.match(result.stdout, /crossbar\.example\.com/);
    assert.match(result.stdout, /in force/);
});
