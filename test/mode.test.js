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

const { applyMode, writtenMode } = require('../src/config');

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
DIRECTORY_CONFIG_PATH=./data/directory.json
`;

const SECTION_BEGIN = '# >>> the configuration in force, written by `node src/admin.js mode` >>>';
const SECTION_END = '# <<< end of the configuration in force <<<';

// The same deployment, with the section a switch has already written: this is the shape a
// real `.env` is in, and the one where "leaves the rest of the file alone" means something.
const MARKED = `# A deployment that holds both configurations.
HOST=127.0.0.1

# The tailnet: a proxy injects the identity header.
NETWORK_MODE_PRIVATE_HOSTNAME=qatar-vpn.taile123.ts.net
NETWORK_MODE_PRIVATE_ORIGIN=https://qatar-vpn.taile123.ts.net

# The open internet: a reverse proxy terminates TLS on the address below.
NETWORK_MODE_PUBLIC_HOSTNAME=crossbar.example.com
NETWORK_MODE_PUBLIC_ORIGIN=https://crossbar.example.com
NETWORK_MODE_PUBLIC_BIND_ADDRESS=203.0.113.7

${SECTION_BEGIN}
CROSSBAR_NETWORK_MODE=private
CROSSBAR_PUBLIC_HOSTNAME=qatar-vpn.taile123.ts.net
PUBLIC_ORIGIN=https://qatar-vpn.taile123.ts.net
CROSSBAR_BIND_ADDRESS=
# Left empty on purpose: the mode decides both. The identity header is believed
# only in private mode, and device keys are required only in public.
TRUST_TAILSCALE_HEADERS=
CROSSBAR_REQUIRE_DEVICE_AUTH=
${SECTION_END}

# The deployment's own settings, below the section on purpose: whether the switch keeps them,
# and keeps them here, is the whole of what it promises.
CROSSBAR_SESSION_SECRET=a-secret-that-must-survive
DATA_DIR=./data
DIRECTORY_CONFIG_PATH=./data/directory.json
`;

// A hand-written override above the section — the case D2 exists for. `loadDotEnv` keeps the
// first value it sees, so this line would quietly beat the mode's own origin.
const CONTRADICTED = MARKED.replace('HOST=127.0.0.1\n', 'HOST=127.0.0.1\nPUBLIC_ORIGIN=http://127.0.0.1:3010\n');

/** What a switch has no business touching: the file with its generated section taken out. */
function outsideSection(content) {
    const lines = content.split('\n');
    const begin = lines.findIndex((line) => line.trim() === SECTION_BEGIN);
    const end = lines.findIndex((line) => line.trim() === SECTION_END);
    return [...lines.slice(0, begin), ...lines.slice(end + 1)].join('\n');
}

/** A deployment directory holding only what the switch reads and writes. */
function deployment(env) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-mode-'));
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    const directory = JSON.stringify({
        users: [{ id: 'one', tailscaleLogin: 'one@dev', displayName: 'One', avatar: '' }],
        contacts: [],
        groups: [],
    });
    fs.writeFileSync(path.join(dir, 'data', 'directory.json'), directory);
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

test('switching rewrites the section and leaves everything outside it byte-identical', () => {
    const content = applyMode(MARKED, 'public');
    assert.match(content, /^CROSSBAR_NETWORK_MODE=public$/m);
    assert.match(content, /^PUBLIC_ORIGIN=https:\/\/crossbar\.example\.com$/m);
    assert.match(content, /^CROSSBAR_BIND_ADDRESS=203\.0\.113\.7$/m);
    // Rewritten, not added to: the private values the section carried are gone, so nothing
    // inside it can still be read by whatever comes after a switch.
    assert.equal(content.match(/^CROSSBAR_NETWORK_MODE=/gm).length, 1);
    assert.equal(content.match(/^CROSSBAR_PUBLIC_HOSTNAME=/gm).length, 1);
    assert.equal(content.match(/^PUBLIC_ORIGIN=/gm).length, 1);
    // Everything else to the byte — comments, blank lines, the settings below the section —
    // and in the same order: a switch owns the section, not the file.
    assert.equal(outsideSection(content), outsideSection(MARKED));
    assert.ok(content.indexOf('CROSSBAR_SESSION_SECRET') > content.indexOf(SECTION_END));
});

test('a file with no section yet gets one, and every line it had is left above it', () => {
    const content = applyMode(CONFIGURED, 'public');
    assert.ok(content.startsWith(CONFIGURED), 'the section is appended, so nothing above it moves');
    assert.match(content, /^CROSSBAR_NETWORK_MODE=public$/m);
    assert.match(content, /^PUBLIC_ORIGIN=https:\/\/crossbar\.example\.com$/m);
    assert.match(content, /^CROSSBAR_BIND_ADDRESS=203\.0\.113\.7$/m);
    // Settings that are not the mode's business are not the switch's business.
    assert.match(content, /^CROSSBAR_SESSION_SECRET=a-secret-that-must-survive$/m);
    assert.match(content, /^DATA_DIR=\.\/data$/m);
});

test('a generated name outside the section is refused, and the message says which line', () => {
    // Refused rather than deleted: the plain names are the supported override for a run that
    // is not a deployment, so the file has to be fixed by the person who wrote it.
    const stale = 'TRUST_TAILSCALE_HEADERS=true\nCROSSBAR_REQUIRE_DEVICE_AUTH=true\nDATA_DIR=./data\n';
    assert.throws(() => applyMode(stale, 'public'),
        /TRUST_TAILSCALE_HEADERS is set outside the generated section, on line 1/);
    // The line below the section is outside it too, and so is a name the switch has not
    // reached yet: it is the position in the file that decides, not which marker is nearer.
    const below = `${MARKED}\nCROSSBAR_PUBLIC_HOSTNAME=somewhere.else\n`;
    assert.throws(() => applyMode(below, 'public'),
        /CROSSBAR_PUBLIC_HOSTNAME is set outside the generated section, on line \d+/);
    // One marker without the other leaves the switch unable to say which lines are its own,
    // and guessing would be how a line of the operator's disappears.
    assert.throws(() => applyMode(`${SECTION_BEGIN}\nDATA_DIR=./data\n`, 'private'), /damaged/);
});

test('switching to the mode already written changes nothing', () => {
    const once = applyMode(CONFIGURED, 'public');
    assert.equal(applyMode(once, 'public'), once);
});

test('a file with no generated section gets one, and the run after that changes nothing', () => {
    // `deploy/.env.example` is this file: both mode blocks, no section yet, because the section
    // is what a switch writes. The mode is in force by default — so nothing inside this process
    // can tell the difference — but both mode shapers run under
    // `ExecCondition=/usr/bin/grep -qx CROSSBAR_NETWORK_MODE=<mode>`, and a fresh private install
    // whose file has no such line never runs `tailscale serve`: the server is healthy on loopback
    // and nobody on the tailnet can reach it. Measured on the rehearsal host, 2026-09-26.
    const dir = deployment(CONFIGURED);
    assert.equal(writtenMode(envFile(dir)), null, 'the fixture is a file that does not say');

    const first = admin(dir, 'mode', 'private');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(writtenMode(envFile(dir)), 'private');

    const once = envFile(dir);
    const second = admin(dir, 'mode', 'private');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(envFile(dir), once, 'the file says so now, so there is nothing left to write');
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

test('a switch that meets an override outside the section refuses, and the file is untouched', () => {
    const dir = deployment(CONTRADICTED);
    const before = envFile(dir);
    const result = admin(dir, 'mode', 'public');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PUBLIC_ORIGIN is set outside the generated section, on line 3/);
    assert.equal(envFile(dir), before, 'a refusal before the write leaves nothing to put back');
});

test('a switch writes in place, where the code directory may not be written, and keeps the file it replaced', () => {
    const dir = deployment(MARKED);
    const before = envFile(dir);
    const ino = fs.statSync(path.join(dir, '.env')).ino;
    // The unit's sandbox, as the console meets it: `data/` and `.env` are writable and the
    // directory holding `.env` is not, under `ProtectSystem=strict`. A rename needs write
    // permission on the directory the name lands in, so the staged-and-moved writer that was
    // here first failed with `EACCES` in exactly this shape — which is why the console could
    // not switch modes while the same command run from a shell could.
    fs.chmodSync(dir, 0o500);
    let result;
    try {
        result = admin(dir, 'mode', 'public');
    } finally {
        fs.chmodSync(dir, 0o700);
    }
    assert.equal(result.status, 0, result.stderr);
    assert.match(envFile(dir), /^CROSSBAR_NETWORK_MODE=public$/m);

    const dataDir = path.join(dir, 'data');
    assert.equal(fs.readFileSync(path.join(dataDir, 'env.previous'), 'utf8'), before,
        'the file as it was, so a switch that lands wrong can still be undone by hand');
    assert.equal(fs.statSync(path.join(dir, '.env')).ino, ino,
        'written through, not replaced: the same file keeps its owner and its mode');
    // `.env` carries the session secret and the console's hash, and so does the copy of it:
    // both are readable by their owner and by nobody else.
    assert.equal(fs.statSync(path.join(dataDir, 'env.previous')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
    // And no staging name was left anywhere, in the deployment directory or beside the copy.
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.env', 'data']);
    assert.deepEqual(fs.readdirSync(dataDir).sort(), ['directory.json', 'env.previous']);
});
