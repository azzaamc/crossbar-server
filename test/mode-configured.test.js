'use strict';

// One answer to "is this mode configured", and the table it is answered from.
//
// The table is why this file exists. A list of names a mode needs is a second source of truth
// the moment nothing checks it against the code that actually demands them: one that said, say,
// `HOSTNAME` for private mode would satisfy every test that reads the list back, and the units
// would then refuse to shape a deployment that starts perfectly. So the table is bound to
// `loadConfig` in both directions, per mode — a file with the names it lists loads, that file
// with each of those names emptied does not, and a name it does not list cannot be one whose
// absence stops the server. The mode units trust the predicate exactly as far as this holds.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { modeConfigured, verifyEnvFile, MODE_REQUIRED, MODE_NAMES, MODES } = require('../src/config');

const ADMIN = path.join(__dirname, '..', 'src', 'admin.js');

/** The values a deployment's block holds, per mode — the shape `.env.example` asks for. */
const BLOCKS = {
    private: { HOSTNAME: 'house.tailnet.ts.net', ORIGIN: 'https://house.tailnet.ts.net', BIND_ADDRESS: '' },
    public: { HOSTNAME: 'crossbar.example.com', ORIGIN: 'https://crossbar.example.com', BIND_ADDRESS: '203.0.113.7' },
};

/** The name a mode's block writes one of `MODE_NAMES` under, as `.env` spells it. */
const blockKey = (mode, name) => `NETWORK_MODE_${mode.toUpperCase()}_${name}`;

/** Everything neither block owns, so the block is the only thing a fixture varies. */
const COMMON = [
    'HOST=127.0.0.1',
    'PORT=3003',
    // Device auth is on by default in public mode and signs sessions with a secret of its own.
    // That name is outside both blocks — a mode's block cannot answer for it — so the fixtures
    // carry it, and what is left to vary is the block and nothing else.
    'CROSSBAR_SESSION_SECRET=a-secret-long-enough-to-count',
    'DATA_DIR=./data',
    'DIRECTORY_CONFIG_PATH=./data/directory.json',
];

/** A `.env` that says `mode` and holds its block, with `blank` — one `MODE_NAMES` name — emptied. */
function envFor(mode, blank = null) {
    const block = BLOCKS[mode];
    return [
        ...COMMON,
        ...MODE_NAMES.map((name) => `${blockKey(mode, name)}=${name === blank ? '' : block[name]}`),
        `CROSSBAR_NETWORK_MODE=${mode}`,
    ].join('\n') + '\n';
}

/** The hazard as a file: it says `public`, and the public block names nothing at all. */
const EMPTY_PUBLIC = [
    ...COMMON,
    ...MODE_NAMES.map((name) => `${blockKey('public', name)}=`),
    'CROSSBAR_NETWORK_MODE=public',
].join('\n') + '\n';

/** A deployment directory holding that one file, which is all `verifyEnvFile` reads. */
function deployment(t, content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-mode-configured-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, '.env'), content);
    return dir;
}

/** The CLI, spawned the way a unit spawns it: an absolute path, and nothing but a `PATH`. */
function admin(...args) {
    return spawnSync(process.execPath, [ADMIN, ...args], {
        env: { PATH: process.env.PATH },
        encoding: 'utf8',
    });
}

test('the required-names table is exactly what loadConfig demands of each mode', (t) => {
    for (const mode of MODES) {
        // A mode that needs nothing must still be one this predicate can say "yes" about, or
        // every unit is skipped and nothing opens a door at all.
        const complete = deployment(t, envFor(mode));
        const loaded = verifyEnvFile(complete, mode);
        assert.equal(loaded.ok, true, `${mode} does not load with its block filled: ${loaded.message}`);

        // A table that lists nothing passes that line, and a table that lists too much refuses a
        // deployment that starts: so each name it does list is emptied in turn and has to stop
        // the server, with the server naming it back.
        for (const name of MODE_REQUIRED[mode]) {
            const dir = deployment(t, envFor(mode, name));
            const check = verifyEnvFile(dir, mode);
            assert.equal(check.ok, false,
                `${mode} loads with ${blockKey(mode, name)} emptied, so the table is wrong to require it`);
            assert.match(check.message, new RegExp(blockKey(mode, name)),
                `and what refuses it names the line the operator has to fill in`);
        }

        // The other direction, and the one that fails silently in production: a name the table
        // does not list cannot be a name the server needs, or this predicate would hold a door
        // shut for a mode that starts perfectly.
        for (const name of MODE_NAMES.filter((listed) => !MODE_REQUIRED[mode].includes(listed))) {
            const dir = deployment(t, envFor(mode, name));
            const check = verifyEnvFile(dir, mode);
            assert.equal(check.ok, true,
                `${mode} does not need ${blockKey(mode, name)}, so it must not be on the list: ${check.message}`);
        }
    }
});

test('the predicate and the process that reads the file agree, name by name', (t) => {
    // `verifyEnvFile` is the question a restart asks — a child process reading nothing but that
    // file — so the predicate is only useful if it is the same answer. Every name a block can
    // hold is emptied in turn, including the ones the table does not list: those have to leave
    // both answers where they were.
    for (const mode of MODES) {
        for (const blank of [null, ...MODE_NAMES]) {
            const dir = deployment(t, envFor(mode, blank));
            const { configured, missing } = modeConfigured(mode, path.join(dir, '.env'));
            const check = verifyEnvFile(dir, mode);
            const said = blank ? `${blockKey(mode, blank)} emptied` : 'its block complete';
            assert.equal(configured, check.ok,
                `${mode} with ${said}: the predicate says ${configured}, the process says ${check.ok} — ${check.message}`);
            if (!configured) {
                assert.ok(missing.length, 'a mode that is not configured names the names that are missing');
            }
        }
    }
});

test('a file saying public with an empty public block is refused, naming what to fill in', (t) => {
    const dir = deployment(t, EMPTY_PUBLIC);
    const envPath = path.join(dir, '.env');

    const refused = admin('mode', '--configured', 'public', envPath);
    assert.equal(refused.status, 1, 'the public shaper must not run for a mode that cannot start');
    assert.match(refused.stderr, /NETWORK_MODE_PUBLIC_HOSTNAME/);
    assert.match(refused.stderr, /NETWORK_MODE_PUBLIC_ORIGIN/);
    assert.equal(refused.stdout, '', 'what a condition reads is the exit code, not a report');

    // The same block filled is what the units act on, and the reported file is the one named
    // rather than the working directory's: this test runs with the repository's own `.env` in
    // the CLI's working directory, on purpose.
    assert.equal(admin('mode', '--configured', 'public', path.join(deployment(t, envFor('public')), '.env')).status, 0);

    // Exactly one of the two shapers may act, so a file that says the other mode is not an
    // answer for this one even when this one's block is complete.
    const other = admin('mode', '--configured', 'private', envPath);
    assert.equal(other.status, 1);
    assert.match(other.stderr, /does not say it is in private/);

    // A fresh install — `.env.example`, its block filled and no generated section yet — is
    // refused for the same reason: the mode in force is a line in the file, not the default the
    // server falls back to, and a shaper that ran on the default would move doors before anyone
    // switched anything.
    const unsaid = deployment(t, envFor('public').replace(/^CROSSBAR_NETWORK_MODE=.*\n/m, ''));
    const fresh = admin('mode', '--configured', 'public', path.join(unsaid, '.env'));
    assert.equal(fresh.status, 1);
    assert.match(fresh.stderr, /does not say it is in public/);

    // A box with no file at all has nothing to be configured, and the question has to name the
    // mode it is about rather than answer about whatever it found.
    assert.equal(admin('mode', '--configured', 'public', path.join(dir, 'nothing.env')).status, 1);
    assert.equal(admin('mode', '--configured').status, 1);
});
