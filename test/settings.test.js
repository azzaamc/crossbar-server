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
// units: a reader only ever sees one whole file, or neither door is configured. So the write
// stages inside the data directory — which the service may write and the code directory it may
// not — keeps what it replaced, and moves the staged file rather than copying it into place.

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

test('a staged write keeps the file it replaced, and leaves no half-written file behind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-env-'));
    const dataDir = path.join(dir, 'data');
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'MAX_PARTICIPANTS=4\n');

    // The data directory is not created first on purpose: a switch is a reasonable thing to
    // run on a machine that has never started the server, and it has to work there.
    withDataDir(dataDir, () => writeEnvFile(envPath, 'MAX_PARTICIPANTS=6\n'));

    assert.equal(fs.readFileSync(envPath, 'utf8'), 'MAX_PARTICIPANTS=6\n');
    assert.equal(fs.readFileSync(path.join(dataDir, 'env.previous'), 'utf8'), 'MAX_PARTICIPANTS=4\n');
    assert.equal(fs.existsSync(path.join(dataDir, '.env.writing')), false, 'moved, not left behind');
    // `.env` holds the session secret and the console's hash, and the kept copy holds the same.
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dataDir, 'env.previous')).mode & 0o777, 0o600);
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
