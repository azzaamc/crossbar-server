'use strict';

// The settings an operator may change, and the ones they may not. Every rule here is one
// whose absence is either a server that will not start or a setting nobody should be able to
// reach from a browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { KNOBS, applyKnobs, validateKnob, knobFor, writeEnvFile } = require('../src/config');

const SAMPLE = [
    '# A deployment.',
    'HOST=127.0.0.1',
    'PORT=3003',
    'MAX_PARTICIPANTS=4',
    'ALLOW_SELF_CALLS=false',
    'CROSSBAR_SESSION_SECRET=keep-me',
    '',
].join('\n');

test('a setting is written where it already was, and nothing else moves', () => {
    const next = applyKnobs(SAMPLE, { MAX_PARTICIPANTS: '6' });
    assert.match(next, /^MAX_PARTICIPANTS=6$/m);
    assert.match(next, /^CROSSBAR_SESSION_SECRET=keep-me$/m);
    assert.match(next, /^HOST=127\.0\.0\.1$/m);
    assert.equal(next.split('MAX_PARTICIPANTS=').length - 1, 1, 'written in place, not appended');
});

test('a setting the file does not have yet is added, not dropped', () => {
    assert.match(applyKnobs(SAMPLE, { CALL_RING_SECONDS: '120' }), /^CALL_RING_SECONDS=120$/m);
});

test('a value outside its range is refused, and says what the range is', () => {
    assert.throws(() => applyKnobs(SAMPLE, { MAX_PARTICIPANTS: '99' }), /between 2 and 8/);
    assert.throws(() => applyKnobs(SAMPLE, { MAX_PARTICIPANTS: 'lots' }), /whole number/);
    assert.throws(() => applyKnobs(SAMPLE, { ICE_STUN_URL: 'somewhere-nearby' }), /stun:host:port/);
});

test('a boolean is written the way the file spells it', () => {
    assert.match(applyKnobs(SAMPLE, { ALLOW_SELF_CALLS: true }), /^ALLOW_SELF_CALLS=true$/m);
    assert.match(applyKnobs(SAMPLE, { ALLOW_SELF_CALLS: 'off' }), /^ALLOW_SELF_CALLS=false$/m);
});

test('nothing that could lock somebody out is on the list', () => {
    const forbidden = ['HOST', 'PORT', 'PUBLIC_ORIGIN', 'CROSSBAR_PUBLIC_HOSTNAME', 'CROSSBAR_BIND_ADDRESS',
        'CROSSBAR_SESSION_SECRET', 'CROSSBAR_ADMIN_PASSWORD_HASH', 'CROSSBAR_TURN_SHARED_SECRET',
        'DATA_DIR', 'DIRECTORY_CONFIG_PATH', 'NODE_ENV', 'CROSSBAR_REQUIRE_DEVICE_AUTH', 'TRUST_TAILSCALE_HEADERS'];
    for (const key of forbidden) {
        assert.equal(knobFor(key), null, `${key} must not be writable from the console`);
        assert.throws(() => applyKnobs(SAMPLE, { [key]: 'anything' }), /may change/, key);
    }
});

test('every knob is described well enough to be rendered, and accepts its own bounds', () => {
    for (const knob of KNOBS) {
        assert.ok(knob.label && knob.label.length > 3, `${knob.key} needs a label`);
        assert.ok(['integer', 'boolean', 'text', 'url'].includes(knob.type), `${knob.key} has an odd type`);
        if (knob.type === 'integer') {
            assert.ok(knob.min < knob.max, `${knob.key} has an empty range`);
            assert.doesNotThrow(() => validateKnob(knob, String(knob.min)), `${knob.key} refuses its own minimum`);
            assert.throws(() => validateKnob(knob, String(knob.max + 1)), `${knob.key} accepts past its maximum`);
        }
    }
});

// ── The write both the console and the CLI go through ────────────────────────
//
// `.env` is read at start-up by the server and, by `ExecCondition` greps, by both front doors'
// units, and the hardened unit grants write to `data/` and to `.env` and to nothing else. So
// the write lands on the file itself — the one thing that permission allows — and the file it
// replaced is kept in the data directory, which is the other.

/** `writeEnvFile` resolves the data directory the way `loadConfig` does: from the environment. */
function withDataDir(dataDir, body) {
    const before = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    try {
        return body();
    } finally {
        if (before === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = before;
    }
}

test('a write lands on the file it was given, and keeps the file it replaced', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-env-'));
    const dataDir = path.join(dir, 'data');
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'MAX_PARTICIPANTS=4\n');

    // The data directory is not created first on purpose: a switch is a reasonable thing to
    // run on a machine that has never started the server, and it has to work there.
    withDataDir(dataDir, () => writeEnvFile(envPath, 'MAX_PARTICIPANTS=6\n'));

    assert.equal(fs.readFileSync(envPath, 'utf8'), 'MAX_PARTICIPANTS=6\n');
    assert.equal(fs.readFileSync(path.join(dataDir, 'env.previous'), 'utf8'), 'MAX_PARTICIPANTS=4\n');
    // `.env` holds the session secret and the console's hash, and the kept copy holds the same.
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dataDir, 'env.previous')).mode & 0o777, 0o600);
    // Nothing anywhere else — no staging name beside the file, and none beside the copy. The
    // directory holding `.env` is the code directory on a deployment, where a reader must not
    // find anything this writer left.
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.env', 'data']);
    assert.deepEqual(fs.readdirSync(dataDir), ['env.previous']);
});

test('a write works where the file may be written and the directory holding it may not', (t) => {
    // The service's sandbox as the unit makes it: `ReadWritePaths=<repo>/data <repo>/.env`
    // under `ProtectSystem=strict`. Writing the file is allowed; creating or removing a *name*
    // in the directory it is in is not. A rename needs write permission on the directory the
    // name lands in, so the staged-and-moved writer failed here with `EACCES` — measured
    // against the live deployment, 2026-09-26, which is the console's mode switch this stands
    // for. A directory mode does not deny root, so the test says so instead of passing for the
    // wrong reason.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        return t.skip('running as root: a directory mode does not deny it');
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-env-'));
    const dataDir = path.join(dir, 'data');
    const envPath = path.join(dir, '.env');
    fs.mkdirSync(dataDir);
    fs.writeFileSync(envPath, 'MAX_PARTICIPANTS=4\n', { mode: 0o600 });
    const ino = fs.statSync(envPath).ino;

    fs.chmodSync(dir, 0o500);
    try {
        withDataDir(dataDir, () => writeEnvFile(envPath, 'MAX_PARTICIPANTS=6\n'));
    } finally {
        fs.chmodSync(dir, 0o700);
    }

    assert.equal(fs.readFileSync(envPath, 'utf8'), 'MAX_PARTICIPANTS=6\n');
    assert.equal(fs.statSync(envPath).ino, ino, 'the same file, written through rather than replaced');
    assert.equal(fs.readFileSync(path.join(dataDir, 'env.previous'), 'utf8'), 'MAX_PARTICIPANTS=4\n');
});

test('a write that cannot complete is reported, and the file that was there is still there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-env-'));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'MAX_PARTICIPANTS=4\n');
    // A data directory that cannot exist, because the path is a file. Nothing may be written,
    // and the failure has to reach the caller: it is the only thing that knows whether the
    // change it asked for still holds, and swallowing this would leave it believing it did.
    const blocked = path.join(dir, 'blocked');
    fs.writeFileSync(blocked, 'not a directory\n');

    assert.throws(() => withDataDir(path.join(blocked, 'data'),
        () => writeEnvFile(envPath, 'MAX_PARTICIPANTS=6\n')), /ENOTDIR/);
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'MAX_PARTICIPANTS=4\n');
});

test('a write keeps a private file private, narrows a public one, and starts at 0600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-env-'));
    const dataDir = path.join(dir, 'data');
    const envPath = path.join(dir, '.env');

    // An operator hardened it, which is a decision a settings change is not allowed to undo.
    fs.writeFileSync(envPath, 'MAX_PARTICIPANTS=4\n');
    fs.chmodSync(envPath, 0o400);
    withDataDir(dataDir, () => writeEnvFile(envPath, 'MAX_PARTICIPANTS=6\n'));
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o400);

    // Readable by everybody is not something this file may be left as: it holds the session
    // secret and the console's hash.
    fs.chmodSync(envPath, 0o644);
    withDataDir(dataDir, () => writeEnvFile(envPath, 'MAX_PARTICIPANTS=8\n'));
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'MAX_PARTICIPANTS=8\n');

    // And a file that is not there yet: the first write is private, which is the floor the two
    // cases above narrow to.
    fs.rmSync(envPath);
    withDataDir(dataDir, () => writeEnvFile(envPath, 'MAX_PARTICIPANTS=4\n'));
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
});

test('a write that fails does not leave the file\u2019s mode lent out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-env-'));
    const dataDir = path.join(dir, 'data');
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'MAX_PARTICIPANTS=4\n');
    fs.chmodSync(envPath, 0o400);

    // Writing in place means the owner-write bit is lent to the file for the length of one
    // write, and a write that throws must not hand it back still lent: `chmod 400 .env` is the
    // whole of what keeps the session secret and the console's hash out of everything else's
    // reach, and `doctor` is the only thing that would notice it gone. An object is not
    // something that can be written, which is how a write that throws is reached here without
    // needing a full disk.
    assert.throws(() => withDataDir(dataDir, () => writeEnvFile(envPath, { not: 'a file' })));
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o400);
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'MAX_PARTICIPANTS=4\n',
        'and the file that was there is untouched');
});

test('a write leaves the file\u2019s owner and identity as they were', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-env-'));
    const dataDir = path.join(dir, 'data');
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'MAX_PARTICIPANTS=4\n', { mode: 0o600 });
    const before = fs.statSync(envPath);

    // Writing in place is what keeps this: the inode is the file's own, so its owner and
    // anything else hung on it stay put. The rename this writer used to do handed `.env` the
    // *staging* file's identity instead — measured on Debian, 2026-09-26, `sudo node
    // src/admin.js mode private` left it owned by root and the service (`User=admin`) could not
    // start, `EACCES` on a file the operator could see and read. There is no longer an owner to
    // put back, and so no refusal to make: the failure the old writer had to detect cannot
    // happen, which is why the test it needed is gone rather than adapted.
    withDataDir(dataDir, () => writeEnvFile(envPath, 'MAX_PARTICIPANTS=6\n'));
    const after = fs.statSync(envPath);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(after.ino, before.ino, 'the file itself, not a replacement');
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'MAX_PARTICIPANTS=6\n');
});
