'use strict';

// The setup wizard, end to end: real answers, real files, in a throwaway deployment tree.
//
// The wizard's whole job is a mapping — answers to the files the deployment runs on — and the
// one promise that matters is the negative one: a chosen mode is never left half-filled, because
// that is the state that closes a working front door. So the tests are about what lands on disk,
// what does *not* land when the answers are short, and what a second run does to what the first
// one wrote. Everything is spawned or called with its own answers, so nothing here touches the
// checkout's own `.env` or `data/`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ADMIN = path.join(__dirname, '..', 'src', 'admin.js');
const { modeBlock, modeConfigured, writtenMode } = require('../src/config');
const { runSetup, readState, natVerdict } = require('../src/setup');

/** The `.env` an install seeds: both blocks, the switch's section, and nothing filled in. */
const TEMPLATE = `HOST=127.0.0.1
PORT=3003

NETWORK_MODE_PRIVATE_HOSTNAME=
NETWORK_MODE_PRIVATE_ORIGIN=

NETWORK_MODE_PUBLIC_HOSTNAME=
NETWORK_MODE_PUBLIC_ORIGIN=
NETWORK_MODE_PUBLIC_BIND_ADDRESS=

# >>> the configuration in force, written by \`node src/admin.js mode\` >>>
CROSSBAR_NETWORK_MODE=private
CROSSBAR_PUBLIC_HOSTNAME=
PUBLIC_ORIGIN=
CROSSBAR_BIND_ADDRESS=
TRUST_TAILSCALE_HEADERS=
CROSSBAR_REQUIRE_DEVICE_AUTH=
# <<< end of the configuration in force <<<

DATA_DIR=./data
DIRECTORY_CONFIG_PATH=./data/directory.json
ICE_STUN_URL=stun:stun.l.google.com:19302
CROSSBAR_SESSION_SECRET=
CROSSBAR_TURN_HOST=
CROSSBAR_TURN_SHARED_SECRET=
`;

const PEOPLE = [
    { id: 'abdullah', name: 'Abdullah', login: 'abdullah@dev', admin: true },
    { id: 'dad', name: 'Dad', login: 'dad@dev' },
];

/** The full answers for a deployment in both modes, which most of these start from. */
const BOTH = {
    mode: 'both',
    privateHostname: 'house.tailnet.ts.net',
    privateOrigin: 'https://house.tailnet.ts.net',
    publicHostname: 'crossbar.example.com',
    publicOrigin: 'https://crossbar.example.com',
    publicBindAddress: '203.0.113.7',
};

const HEX_32 = /^[0-9a-f]{64}$/;

function deployment(t, seed = TEMPLATE) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-setup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, '.env'), seed);
    return dir;
}

/** A throwaway directory for a file that is not a deployment — an answers file, a require hook. */
function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-setup-scratch-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** The people in a file of their own, so a flag can carry them without a shell quoting game. */
function peopleFile(t, people = PEOPLE) {
    const file = path.join(scratch(t), 'people.json');
    fs.writeFileSync(file, `${JSON.stringify(people, null, 2)}\n`);
    return file;
}

function answersFile(dir, answers) {
    const file = path.join(dir, 'answers.json');
    fs.writeFileSync(file, `${JSON.stringify(answers, null, 2)}\n`);
    return file;
}

/** The CLI, run from the deployment the way a person runs it: that directory, and nothing else. */
function setup(dir, ...args) {
    return spawnSync(process.execPath, [ADMIN, 'setup', ...args], {
        cwd: dir,
        env: { PATH: process.env.PATH },
        encoding: 'utf8',
    });
}

/**
 * A prompter that draws nothing and answers from a script, recording every question and every note.
 *
 * `runSetup` asks a prompter the same questions whether or not it can draw them, so this is the
 * cheapest way to hold the *wording* to account — and the wording is the only thing some defects
 * live in. A question here is a template literal in `src/setup.js`; `' + '` written inside one of
 * those is printed rather than joined, and the screen then says `knows' + ' them by`. Nothing that
 * reads the answers back can see that, and this can.
 *
 * A script entry is the next answer; `undefined` takes the default the question offered, which is
 * what pressing Enter does at a real prompt.
 */
function recordingTerminal(script) {
    const asked = [];
    const notes = [];
    const next = (fallback) => {
        const value = script.length ? script.shift() : undefined;
        return value === undefined ? fallback : value;
    };
    return {
        present: true,
        asked,
        notes,
        intro: (title) => notes.push(title),
        outro: (message) => notes.push(message),
        note: (body, title) => notes.push(`${title}:\n${body}`),
        spinner: () => ({ start() {}, stop() {}, message() {} }),
        select: async ({ message, options, initial }) => {
            asked.push({ kind: 'select', message, options });
            return String(next(initial ?? options[0].value));
        },
        text: async ({ message, placeholder, defaultValue = '' }) => {
            asked.push({ kind: 'text', message, placeholder, defaultValue });
            return String(next(defaultValue));
        },
        confirm: async ({ message, initialValue }) => {
            asked.push({ kind: 'confirm', message });
            return Boolean(next(initialValue));
        },
    };
}

const envOf = (dir) => fs.readFileSync(path.join(dir, '.env'), 'utf8');
const directoryOf = (dir) => fs.readFileSync(path.join(dir, 'data', 'directory.json'), 'utf8');

test('the answers become the files the switch reads', (t) => {
    const dir = deployment(t);
    const file = answersFile(dir, {
        ...BOTH,
        people: PEOPLE,
        turnHost: 'relay.example.com',
        apnsKeyId: 'ABC123',
        apnsTeamId: 'TEAM123',
        apnsKeyPath: '/etc/crossbar/apns.p8',
        apnsTopic: 'com.example.crossbar',
        vapidPublicKey: 'vapid-public',
        vapidPrivateKey: 'vapid-private',
        vapidSubject: 'mailto:abdullah@example.com',
    });

    const result = setup(dir, '--answers', file, '--skip-checks');
    assert.equal(result.status, 0, result.stderr);

    // Both chosen modes, complete: the names each one is reached at, and the address Caddy takes.
    const env = envOf(dir);
    const envPath = path.join(dir, '.env');
    assert.deepEqual(modeBlock(env, 'private'),
        { HOSTNAME: BOTH.privateHostname, ORIGIN: BOTH.privateOrigin, BIND_ADDRESS: '' });
    assert.deepEqual(modeBlock(env, 'public'),
        { HOSTNAME: BOTH.publicHostname, ORIGIN: BOTH.publicOrigin, BIND_ADDRESS: BOTH.publicBindAddress });
    assert.equal(modeConfigured('private', envPath).configured, true);
    assert.equal(modeConfigured('public', envPath).configured, true);

    // The section in force is the switch's own, written by `applyMode`: the file said private, and
    // nothing asked it to change, so private it stays — with the private values expanded into the
    // names the server, Caddy and the units read.
    assert.equal(writtenMode(env), 'private');
    assert.match(env, /^CROSSBAR_PUBLIC_HOSTNAME=house\.tailnet\.ts\.net$/m);
    assert.match(env, /^PUBLIC_ORIGIN=https:\/\/house\.tailnet\.ts\.net$/m);
    assert.match(env, /^CROSSBAR_BIND_ADDRESS=$/m);

    // The secrets, the relay and the push material.
    const state = readState(dir);
    assert.match(state.secrets.session, HEX_32, 'the session secret is 32 bytes of hex');
    assert.match(state.secrets.turn, HEX_32, 'the relay secret is 32 bytes of hex');
    assert.equal(state.turnHost, 'relay.example.com');
    assert.deepEqual(state.vapid, { publicKey: 'vapid-public', privateKey: 'vapid-private', subject: 'mailto:abdullah@example.com' });
    assert.deepEqual(state.apns, { keyId: 'ABC123', teamId: 'TEAM123', keyPath: '/etc/crossbar/apns.p8', topic: 'com.example.crossbar' });

    // The directory: the people, who administers, and everybody able to reach everybody — a
    // directory with no pairs in it reads as an empty app.
    const directory = JSON.parse(directoryOf(dir));
    assert.deepEqual(directory.users, [
        { id: 'abdullah', tailscaleLogin: 'abdullah@dev', displayName: 'Abdullah', admin: true },
        { id: 'dad', tailscaleLogin: 'dad@dev', displayName: 'Dad' },
    ]);
    assert.deepEqual(directory.contacts, [
        { ownerId: 'abdullah', contactId: 'dad', sortOrder: 0 },
        { ownerId: 'dad', contactId: 'abdullah', sortOrder: 0 },
    ]);
    assert.equal(directory.groups[0].memberIds.join(), 'abdullah,dad');
    assert.equal(fs.statSync(path.join(dir, 'data', 'directory.json')).mode & 0o777, 0o600);
});

test('a chosen mode with a name missing is refused before anything is written', (t) => {
    const dir = deployment(t);
    const before = envOf(dir);
    const people = peopleFile(t);

    // Public cannot be started without the name it is reached at, and no default is invented for
    // it: the refusal names the answer, not the answer's absence.
    const refused = setup(dir, '--mode', 'public', '--public-bind-address', '203.0.113.7', '--people', `@${people}`, '--no-ask');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--public-hostname/);
    assert.match(refused.stderr, /--public-origin/);
    assert.equal(envOf(dir), before, 'the .env is byte-for-byte what it was');
    assert.equal(fs.existsSync(path.join(dir, 'data')), false, 'and nothing else was written either');

    // The mode rule is what makes this a refusal rather than a write: the same answers with the
    // name filled in are accepted, so the test above is about the missing name and not the flags.
    const accepted = setup(dir, '--mode', 'public', '--public-hostname', 'crossbar.example.com',
        '--public-origin', 'https://crossbar.example.com', '--public-bind-address', '203.0.113.7',
        '--people', `@${people}`, '--no-ask', '--skip-checks');
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(modeConfigured('public', path.join(dir, '.env')).configured, true);
});

test('the wildcard bind address is refused, which is the one that looks right', (t) => {
    const dir = deployment(t);
    const before = envOf(dir);
    const people = peopleFile(t);

    // Every address includes the one tailscaled holds in public mode, so Caddy never takes the
    // port: what an operator sees is a TLS failure about a hostname that is configured correctly.
    for (const wildcard of ['0.0.0.0', '::', '*']) {
        const refused = setup(dir, '--mode', 'public', '--public-hostname', 'crossbar.example.com',
            '--public-origin', 'https://crossbar.example.com', '--public-bind-address', wildcard,
            '--people', `@${people}`, '--no-ask');
        assert.equal(refused.status, 1, `${wildcard} must be refused`);
        assert.match(refused.stderr, /tailscaled/);
        // The refusal leads with what to do, and names the value it means by "every address":
        // a first-time reader meets this message instead of a certificate error three steps later.
        assert.match(refused.stderr, /Name the one address this server is reached at/);
        assert.match(refused.stderr, /0\.0\.0\.0 is every address/);
        assert.equal(envOf(dir), before);
        assert.equal(fs.existsSync(path.join(dir, 'data')), false);
    }
});

test('an answer the wizard does not read is refused rather than ignored', (t) => {
    const dir = deployment(t);
    // The same failure `unreadEnvKeys` exists to catch in `.env`: a name nothing reads does
    // nothing at all, so a typo'd answer has to be said rather than silently defaulted over.
    const file = answersFile(dir, { mode: 'private', privateHostName: 'house.tailnet.ts.net' });
    const refused = setup(dir, '--answers', file, '--no-ask');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /privateHostName/);
    assert.match(refused.stderr, /mode/);
});

test('re-running keeps the secrets, the blocks and the directory already there', (t) => {
    const dir = deployment(t);
    const first = answersFile(dir, { ...BOTH, people: PEOPLE, turnHost: 'relay.example.com' });
    assert.equal(setup(dir, '--answers', first, '--skip-checks').status, 0);

    const written = envOf(dir);
    const secrets = readState(dir).secrets;
    const directory = directoryOf(dir);

    // The same answers again, without the people and without either secret: what the file holds is
    // the default offered, so a second run is a no-op rather than a re-roll.
    const second = answersFile(dir, BOTH);
    assert.equal(setup(dir, '--answers', second, '--skip-checks').status, 0);
    assert.equal(envOf(dir), written, 'a second run writes the same bytes');
    assert.deepEqual(readState(dir).secrets, secrets, 'and keeps both secrets');
    assert.equal(directoryOf(dir), directory, 'and leaves the directory file alone');
});

test('a mode not being set up is left exactly as it is, and a chosen one is put in force', (t) => {
    const people = peopleFile(t);

    // Public mode, alone: the section in force is public, and the address Caddy binds is in it.
    const publicDir = deployment(t);
    const publicRun = setup(publicDir, '--mode', 'public', '--public-hostname', 'crossbar.example.com',
        '--public-origin', 'https://crossbar.example.com', '--public-bind-address', '203.0.113.7',
        '--people', `@${people}`, '--no-ask', '--skip-chunks');
    assert.notEqual(publicRun.status, 0, 'an unknown flag is not silently accepted');

    const publicOk = setup(publicDir, '--mode', 'public', '--public-hostname', 'crossbar.example.com',
        '--public-origin', 'https://crossbar.example.com', '--public-bind-address', '203.0.113.7',
        '--people', `@${people}`, '--no-ask', '--skip-checks');
    assert.equal(publicOk.status, 0, publicOk.stderr);
    const publicEnv = envOf(publicDir);
    assert.equal(writtenMode(publicEnv), 'public');
    assert.match(publicEnv, /^CROSSBAR_BIND_ADDRESS=203\.0\.113\.7$/m);
    assert.match(publicEnv, /^CROSSBAR_PUBLIC_HOSTNAME=crossbar\.example\.com$/m);

    // Private mode, alone, in a tree whose public block was never filled in: the lines stay as they
    // were — empty — and public stays something this file cannot be shaped for.
    const privateDir = deployment(t);
    const privateOk = setup(privateDir, '--mode', 'private', '--private-hostname', 'house.tailnet.ts.net',
        '--private-origin', 'https://house.tailnet.ts.net', '--people', `@${people}`, '--no-ask', '--skip-checks');
    assert.equal(privateOk.status, 0, privateOk.stderr);
    const privateEnv = envOf(privateDir);
    assert.match(privateEnv, /^NETWORK_MODE_PUBLIC_HOSTNAME=$/m);
    assert.match(privateEnv, /^NETWORK_MODE_PUBLIC_ORIGIN=$/m);
    assert.match(privateEnv, /^NETWORK_MODE_PUBLIC_BIND_ADDRESS=$/m);
    assert.deepEqual(modeBlock(privateEnv, 'public'), { HOSTNAME: '', ORIGIN: '', BIND_ADDRESS: '' });
    assert.equal(modeConfigured('public', path.join(privateDir, '.env')).configured, false);
    assert.equal(writtenMode(privateEnv), 'private');
});

test('the answers file and the answers typed at a prompt produce the same files', async (t) => {
    const fromFile = deployment(t);
    const fromPrompt = deployment(t);
    const secrets = { sessionSecret: 'ab'.repeat(32), turnSecret: 'cd'.repeat(32) };

    const file = answersFile(fromFile, { ...BOTH, people: PEOPLE, turnHost: 'relay.example.com', ...secrets });
    assert.equal(setup(fromFile, '--answers', file, '--skip-checks').status, 0);

    // The same answers, one question at a time, in the order the questions are asked.
    const script = [
        'both',
        BOTH.privateHostname, BOTH.privateOrigin,
        BOTH.publicHostname, BOTH.publicOrigin, BOTH.publicBindAddress,
        'abdullah, Abdullah, abdullah@dev, admin',
        'dad, Dad, dad@dev',
        '',
        'relay.example.com',
        '',
        '',
    ];
    const ask = async (_prompt, fallback = '') => {
        const answer = script.shift() ?? '';
        return answer || fallback;
    };
    await runSetup({
        dir: fromPrompt,
        answers: secrets,
        ask,
        log: () => {},
        check: false,
    });
    assert.equal(script.length, 0, 'every question was asked, in order, and answered');

    assert.equal(envOf(fromPrompt), envOf(fromFile));
    assert.equal(directoryOf(fromPrompt), directoryOf(fromFile));
});

test('the optional questions say they can be skipped, and that an Apple key is the team\'s', async (t) => {
    // The owner stopped at the APNs question to ask why a key was needed when another deployment
    // already had one. The note above the step had not answered that, and the question's wording is
    // the only thing a person reads — so what these questions say is the thing under test.
    const dir = deployment(t);
    const asked = [];
    const script = ['', '', '']; // the relay, APNs, then Web Push: each skipped with a blank line
    const ask = async (prompt) => {
        asked.push(prompt);
        return script.shift() ?? '';
    };
    await runSetup({ dir, answers: { ...BOTH, people: PEOPLE }, ask, log: () => {}, check: false });
    assert.equal(script.length, 0, 'every optional question was asked');

    const apns = asked.find((prompt) => /Push is optional/.test(prompt));
    assert.ok(apns, `the APNs question was asked: ${asked.join(' | ')}`);
    assert.match(apns, /blank skips it/);
    assert.match(apns, /a phone whose screen is off cannot be rung/);
    // The team credential, and the three values another deployment of the same app shares — which
    // is the answer the owner had to ask for.
    assert.match(apns, /belongs to the Apple team, not to this server/);
    assert.match(apns, /key id/);
    assert.match(apns, /team id/);
    assert.match(apns, /topic/);

    const webpush = asked.find((prompt) => /Web Push/.test(prompt));
    assert.ok(webpush, `the Web Push question was asked: ${asked.join(' | ')}`);
    assert.match(webpush, /Web Push is optional/);
    assert.match(webpush, /blank skips it/);
    assert.match(webpush, /a closed browser cannot be woken/);

    // And the blank lines at each are what skipped them: the file holds none of the four names.
    assert.deepEqual(readState(dir).apns, { keyId: '', teamId: '', keyPath: '', topic: '' });
    assert.deepEqual(readState(dir).vapid, { publicKey: '', privateKey: '', subject: '' });

    // The question for a key pair says where a pair comes from: a person who has never made one
    // cannot answer "its VAPID public key" at all, and nowhere else in the run says it either.
    assert.match(webpush, /generate-vapid-keys/);
    // And the APNs question says which of its four values this prompt is for, because it is the one
    // question in the run whose answer opens three more.
    assert.match(apns, /This question asks for the key id; the three after it ask/);
});

test('the questions a first-time reader meets name the thing and show an answer', async (t) => {
    // Every question the wizard asks a terminal, read as a person who has never seen Crossbar. The
    // assertion that matters is the person id's exact text: it is a template literal, and the `' + '`
    // that used to sit inside it was printed at the screen rather than joined — a defect no
    // answers-to-files test can see.
    const dir = deployment(t);
    const terminal = recordingTerminal([
        'public',
        'calls.example.com', undefined, '203.0.113.7',   // hostname, origin (derived), bind address
        'abdullah', 'Abdullah', 'abdullah@dev', undefined, undefined, // one person, not an admin: no
        undefined, undefined, undefined,                  // relay, APNs and Web Push: each skipped
        false, false,                                     // no console password, no invitation
    ]);
    await runSetup({
        dir,
        answers: {},
        ask: terminal,
        log: () => {},
        check: false,
        tailscale: '',
        locals: ['192.168.1.10', '127.0.0.1', '169.254.1.9', '100.64.3.4', '203.0.113.7', 'fe80::1', 'fd7a:115c:a1e0::b635:a0c'],
    });

    const messageOf = (pattern) => {
        const found = terminal.asked.find((question) => pattern.test(question.message));
        assert.ok(found, `no question matched ${pattern}: ${terminal.asked.map((q) => q.message).join(' | ')}`);
        return found.message;
    };

    // The mode question says what Tailscale is: a tailnet is not a word a first-timer has.
    assert.match(messageOf(/reach this deployment/), /over Tailscale, a private network/);
    // The person id: one clean question, and the one that is not about a value the machine knows.
    assert.equal(terminal.asked.find((question) => /short id/.test(question.message)).message,
        'The first person: the short id everybody else knows them by (for example: abdullah)');
    // The login is needed in private mode and optional in public, and the question says both — the
    // blank it used to invite was refused after the last question had been asked.
    assert.match(messageOf(/Tailscale login/), /a private deployment finds people by this/);
    // The bind address is this host's address, so the question shows the host's own: no loopback,
    // no link-local, no tailnet, no IPv6 — the candidates are what a router could forward to.
    assert.match(messageOf(/web front end \(Caddy\)/),
        /this host's own IPv4 addresses: 192\.168\.1\.10, 203\.0\.113\.7$/);
    // The origin is derived, so the question says the Enter key keeps what it is showing.
    assert.match(messageOf(/invitation opens/), /press Enter to keep the one this question offers/);
    // The relay is named, and so is where its value comes from when the relay is this server.
    assert.match(messageOf(/relayed through a TURN server/), /if the relay runs on this server/);
});

test('the notes and the summary say what the questions said, without a sentence broken in half', async (t) => {
    // A note is wrapped at spaces, so a newline written inside a sentence comes out as a line that
    // ends early — the optional-material note said "the summary says what it went" / "without:".
    // The notes are collected raw here, which is the one place that breakage is visible.
    const dir = deployment(t);
    const terminal = recordingTerminal([
        'public',
        'calls.example.com', undefined, '203.0.113.7',
        'abdullah', 'Abdullah', '', undefined, undefined,
        undefined, undefined, undefined,
        false, false,
    ]);
    await runSetup({ dir, answers: {}, ask: terminal, log: () => {}, check: false, tailscale: '' });

    const optional = terminal.notes.find((note) => note.includes('Relay'));
    assert.ok(optional, `the optional-material note was not made: ${terminal.notes.join(' | ')}`);
    assert.match(optional, /the summary says what it went without:/);
    assert.doesNotMatch(optional, /went\nwithout/);

    // The summary repeats the questions' own words, not a vocabulary of its own.
    const summary = terminal.notes.find((note) => /^Crossbar setup:\n/.test(note) && note.includes('Verified'));
    assert.ok(summary, `the summary was not made: ${terminal.notes.join(' | ')}`);
    assert.match(summary, /not configured — calls still work, but some networks will fail/);
    assert.match(summary, /session \(what signs a device in\) generated \(32 bytes of hex\)/);
});

test('a generated secret is 32 bytes of hex, and a second run generates a different one', (t) => {
    const first = deployment(t);
    const second = deployment(t);
    const answers = { ...BOTH, people: PEOPLE, turnHost: 'relay.example.com' };

    for (const dir of [first, second]) {
        const file = answersFile(dir, answers);
        assert.equal(setup(dir, '--answers', file, '--skip-checks').status, 0);
    }
    const one = readState(first).secrets;
    const two = readState(second).secrets;
    assert.match(one.session, HEX_32);
    assert.match(one.turn, HEX_32);
    assert.notEqual(one.session, two.session);
    assert.notEqual(one.turn, two.turn);

    // The one thing that replaces a secret already in the file, and it has to be asked for: the
    // session secret is what signs devices in, so losing it signs everybody out.
    const kept = answersFile(first, { ...answers, sessionSecret: undefined });
    assert.equal(setup(first, '--answers', kept, '--skip-checks').status, 0);
    assert.equal(readState(first).secrets.session, one.session);

    const rerolled = answersFile(first, { ...answers, newSecrets: true });
    assert.equal(setup(first, '--answers', rerolled, '--skip-checks').status, 0);
    const after = readState(first).secrets;
    assert.match(after.session, HEX_32);
    assert.notEqual(after.session, one.session);
    assert.notEqual(after.turn, one.turn);
});

test('setup runs on a host whose dependencies are not installed yet', (t) => {
    // `install.sh` runs `npm ci` before the wizard now, precisely because of this: the wizard's
    // public-mode checks load `diagnostics`, which needs `ws`, and a fresh host with no
    // `node_modules` died on it. The by-hand path (`node src/admin.js setup` on a checkout with no
    // dependencies) is still that host, and `--skip-checks` is the flag for it; `diagnostics` is
    // the one module this CLI reaches that needs one. The hook is that host: it makes both
    // dependencies unresolvable, and setup still has to work.
    const dir = deployment(t);
    const hook = path.join(dir, 'no-modules.js');
    fs.writeFileSync(hook, `
const Module = require('node:module');
const load = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'ws' || request === 'web-push') {
        const error = new Error(\`Cannot find module '\${request}'\`);
        error.code = 'MODULE_NOT_FOUND';
        throw error;
    }
    return load.apply(this, arguments);
};
`);
    const file = answersFile(dir, { ...BOTH, people: PEOPLE });
    const result = spawnSync(process.execPath, ['--require', hook, ADMIN, 'setup', '--answers', file, '--skip-checks'], {
        cwd: dir,
        env: { PATH: process.env.PATH },
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(modeConfigured('public', path.join(dir, '.env')).configured, true);
    assert.equal(JSON.parse(directoryOf(dir)).users.length, 2);
});

test('the NAT reading says what it measured, and could not determine what it cannot', () => {
    // 100.64.0.0/10 is the range a carrier-grade NAT hands out, and the one tell readable from
    // inside the box. Everything else is reported as what it is, because only the ISP can say.
    const carrier = natVerdict({ address: '100.64.3.4', port: 40000 }, []);
    assert.equal(carrier.verdict, 'warn');
    assert.match(carrier.detail, /carrier-grade NAT address/);
    assert.match(carrier.detail, /only the ISP/);

    const own = natVerdict({ address: '203.0.113.7', port: 40000 }, ['203.0.113.7']);
    assert.equal(own.verdict, 'ok');
    assert.match(own.detail, /nothing is translating/);

    const translated = natVerdict({ address: '203.0.113.7', port: 40000 }, ['10.0.0.5']);
    assert.equal(translated.verdict, 'warn');
    assert.match(translated.detail, /port forward/);

    const private_ = natVerdict({ address: '192.168.1.9', port: 40000 }, ['10.0.0.5']);
    assert.equal(private_.verdict, 'unknown');
    assert.match(private_.detail, /could not be determined/);
});
