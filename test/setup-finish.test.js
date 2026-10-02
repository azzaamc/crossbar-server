'use strict';

// The three things the installer used to leave to a person: the private address it asked for
// blind, and the console password and first invitation it printed as next steps.
//
// The private address is now derived from the machine's own tailnet name, through an injectable
// command so this file can fixture Tailscale's answer — and a machine that has none still has to
// be asked a question that reads. The password and the invitation are now questions that run
// their own command in the terminal, and neither runs where there is no terminal to run it in.
//
// The frames are asserted where the wording is the point: they are what a person reads, and the
// spelling of a question is not something a passing test would otherwise notice.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { runSetup, tailnetName } = require('../src/setup');
const { createPrompter } = require('../src/prompt');

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

function deployment(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-finish-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, '.env'), TEMPLATE);
    return dir;
}

/**
 * A `tailscale` on disk, as `runSetup`'s `tailscale` option takes one: the same injectable-command
 * seam `checkTailscale` in `src/diagnostics.js` uses, so a test need not have the real thing.
 */
function fakeTailscale(t, body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-tailscale-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'tailscale');
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
    return file;
}

/** A stream that is a terminal as far as the renderer is concerned, and a person who types. */
function terminal(t) {
    const input = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (raw) => { input.isRaw = raw; };
    const output = new PassThrough();
    output.isTTY = true;
    output.columns = 80;
    let written = '';
    output.on('data', (chunk) => { written += chunk; });
    t.after(() => { input.destroy(); output.destroy(); });
    return {
        input,
        output,
        ui: createPrompter({ input, output, interval: 100000 }),
        /** The same with the cursor moves taken out, which is what a person would have seen. */
        seen: () => written.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, ''),
    };
}

/** One key at a time, each on its own tick, the way a keyboard delivers them. */
async function press(input, ...keys) {
    for (const key of keys) {
        input.write(key);
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

/** A private run whose two addresses are the only things left to ask. */
const PRIVATE = {
    mode: 'private', people: PEOPLE, password: false, invite: false,
    // These tests are about the prompt mechanics, not the relay, and a run that names no relay
    // would otherwise enrol with the shared relay over the network.
    pushRelay: 'none',
};

test('tailnetName drops the trailing dot, and is empty rather than wrong', (t) => {
    const good = fakeTailscale(t, `printf '%s' '{"Self":{"DNSName":"crossbar.tailnet-name.ts.net."}}'`);
    assert.equal(tailnetName(good), 'crossbar.tailnet-name.ts.net');

    // Every way the command can fail to answer is an ordinary state, not a thrown error: a daemon
    // that is not installed, not running, or logged out all look like this to the wizard.
    assert.equal(tailnetName('/nonexistent/tailscale'), '');
    assert.equal(tailnetName(fakeTailscale(t, 'echo not json')), '');
    assert.equal(tailnetName(fakeTailscale(t, 'printf "%s" "{}"')), '');
});

test('the private address is offered as the tailnet name Tailscale reports', async (t) => {
    const dir = deployment(t);
    const fake = fakeTailscale(t, `printf '%s' '{"Self":{"DNSName":"crossbar.tailnet-name.ts.net."}}'`);
    const asked = [];
    // Enter at every question: whatever is offered is what the run takes, which is the whole
    // claim being tested.
    const ask = async (message, fallback = '') => { asked.push({ message, fallback }); return ''; };

    await runSetup({ dir, answers: PRIVATE, ask, check: false, tailscale: fake, log: () => {} });

    const host = asked.find((question) => /dial over the tailnet/.test(question.message));
    assert.ok(host, 'the private hostname is asked');
    assert.equal(host.fallback, 'crossbar.tailnet-name.ts.net', 'the trailing dot is dropped');
    // The question is one short line now: what Tailscale is, and what approves the machine, is a
    // note beside the join and the runbook (§2.2.1), not the question. This machine has a name, so
    // the line also says the field holds it.
    assert.match(host.message, /^Private \(tailnet\): the address people dial over the tailnet/);
    assert.match(host.message, /this machine is on your tailnet already/);
    const origin = asked.find((question) => /invitation opens/.test(question.message));
    assert.equal(origin.fallback, 'https://crossbar.tailnet-name.ts.net', 'the origin is derived from the address');
    // Offered is not enough: it has to be what landed in the file.
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'),
        /^NETWORK_MODE_PRIVATE_HOSTNAME=crossbar\.tailnet-name\.ts\.net$/m);
});

test('a machine with no Tailscale is asked a question that reads, and can be answered', async (t) => {
    const dir = deployment(t);
    const where = terminal(t);
    const run = runSetup({
        dir, answers: PRIVATE, ask: where.ui, check: false,
        tailscale: '/nonexistent/tailscale', log: () => {},
    });
    // Enter through the approach question, type the address, then Enter through the origin, the
    // relay and the push relay.
    await press(where.input, '\r', 'house.tailnet.ts.net', '\r', '\r', '\r', '\r');
    await run;

    const seen = where.seen();
    // The wording is the point: it names the thing in one line, so a reader who has never seen
    // Crossbar can answer it.
    assert.match(seen, /◆\s+Private \(tailnet\): the address people dial over the tailnet/);
    // No default was invented without Tailscale: the field is empty until it is typed, and what
    // was typed is what the file holds.
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'),
        /^NETWORK_MODE_PRIVATE_HOSTNAME=house\.tailnet\.ts\.net$/m);
});

test('the console password and the first invitation are questions, defaulting to yes', async (t) => {
    const dir = deployment(t);
    const where = terminal(t);
    const ran = [];
    const spawn = (_command, args) => { ran.push(args.slice(1)); return 0; };
    const run = runSetup({
        dir, answers: { mode: 'private', people: PEOPLE, pushRelay: 'none' }, ask: where.ui, check: false, spawn,
        tailscale: '', log: () => {},
    });
    // The approach, the address, the origin, the two relays, then Enter at each finishing question.
    await press(where.input, '\r', 'house.tailnet.ts.net', '\r', '\r', '\r', '\r', '\r', '\r');
    await run;

    const seen = where.seen();
    assert.match(seen, /◆\s+Set the console password now\?/, 'the password is asked, not printed as a next step');
    assert.match(seen, /◆\s+Invite somebody now\?/, 'and so is the first invitation');
    // Both defaulted to yes and ran the commands that own the prompt and the one-time token, in
    // this terminal.
    assert.deepEqual(ran, [['password'], ['enroll', '--user', 'abdullah']]);
});

test('neither finishing step runs when there is no terminal', async (t) => {
    const dir = deployment(t);
    const ran = [];
    const lines = [];
    const result = await runSetup({
        dir,
        answers: {
            ...PRIVATE,
            privateHostname: 'house.tailnet.ts.net',
            privateOrigin: 'https://house.tailnet.ts.net',
            password: true,
            invite: true,
        },
        ask: null,
        check: false,
        spawn: (_command, args) => { ran.push(args.slice(1)); return 0; },
        log: (line) => lines.push(String(line)),
    });

    assert.deepEqual(ran, [], 'a password prompt with nobody at it is not run');
    assert.deepEqual(result.done, { password: false, invite: false });
    // And the summary leaves them as commands rather than claiming they happened.
    assert.ok(lines.some((line) => /node src\/admin\.js password/.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /node src\/admin\.js enroll --user abdullah/.test(line)), lines.join('\n'));
});

/**
 * A `tailscale` that has no tailnet name until its own `up` is run, and one after — which is what
 * the daemon looks like either side of the approval, and the whole reason the wizard runs the join
 * itself. `up` records its argv, so a test can see the name the login was told to use.
 */
function joiningTailscale(t, { name = 'crossbar-dev.tailnet-name.ts.net', approved = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-join-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const state = path.join(dir, 'joined');
    const argv = path.join(dir, 'argv');
    const file = path.join(dir, 'tailscale');
    fs.writeFileSync(file, [
        '#!/bin/sh',
        `argv=${JSON.stringify(argv)}`,
        `state=${JSON.stringify(state)}`,
        `name=${JSON.stringify(name)}`,
        'if [ "$1" = \'up\' ]; then',
        '    printf \'%s\\n\' "$*" >> "$argv"',
        `    if [ ${approved ? '0' : '1'} = 0 ]; then printf '%s' "$name" > "$state"; exit 0; fi`,
        '    exit 1',
        'fi',
        'if [ "$1" = \'status\' ]; then',
        '    if [ -f "$state" ]; then printf \'{"Self":{"DNSName":"%s."}}\\n\' "$(cat "$state")";',
        '    else printf \'{"Self":{}}\\n\'; fi',
        '    exit 0',
        'fi',
        'exit 0',
    ].join('\n'));
    fs.chmodSync(file, 0o755);
    return { file, up: () => (fs.existsSync(argv) ? fs.readFileSync(argv, 'utf8').trim() : '') };
}

test('the machine is joined before the address is asked, and the name it got replaces a guess', async (t) => {
    const dir = deployment(t);
    // What an earlier run left behind: the address the wizard was answered with before this machine
    // had a tailnet name at all. It is the case the join exists for — the field must hold the name
    // the machine answers at, not the guess, and nothing may be asked about the guess.
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, fs.readFileSync(envPath, 'utf8')
        .replace('NETWORK_MODE_PRIVATE_HOSTNAME=', 'NETWORK_MODE_PRIVATE_HOSTNAME=stale.tail1234.ts.net')
        .replace('NETWORK_MODE_PRIVATE_ORIGIN=', 'NETWORK_MODE_PRIVATE_ORIGIN=https://stale.tail1234.ts.net'));
    const where = terminal(t);
    const tailscale = joiningTailscale(t);
    const run = runSetup({
        dir, answers: PRIVATE, ask: where.ui, check: false, tailscale: tailscale.file, log: () => {},
    });
    // Enter at every question — the approach, the address the join produced, the origin, the relay
    // and the push relay: taking the offered value is the confirmation.
    await press(where.input, '\r', '\r', '\r', '\r', '\r', '\r');
    await run;

    // The join ran here, as this account, naming the node after the deployment.
    assert.match(tailscale.up(), /^up --hostname crossbar-finish-/, `the join was not run, or unnamed: ${tailscale.up()}`);
    const seen = where.seen();
    // It happened *before* the address was asked for — which is the whole point: the address is a
    // derived value to confirm, not a question answered from expectation.
    const joined = seen.indexOf('joined your tailnet as crossbar-dev.tailnet-name.ts.net');
    const asked = seen.indexOf('dial over the tailnet');
    assert.ok(joined >= 0, `the join is not reported:\n${seen}`);
    assert.ok(asked > joined, `the address was asked before the machine was joined:\n${seen}`);
    assert.match(seen, /this machine is on your tailnet already, so the field holds the name it answers at/,
        'the address is not offered as a value to confirm');
    // And the offered value is what was written, both spellings of one address — in place of the
    // stale one, which nothing asked about.
    const env = fs.readFileSync(envPath, 'utf8');
    assert.match(env, /^NETWORK_MODE_PRIVATE_HOSTNAME=crossbar-dev\.tailnet-name\.ts\.net$/m);
    assert.match(env, /^NETWORK_MODE_PRIVATE_ORIGIN=https:\/\/crossbar-dev\.tailnet-name\.ts\.net$/m);
    assert.ok(!env.includes('stale.tail1234.ts.net'), `the guess is still in .env:\n${env}`);
});

test('a join that does not finish asks for the address rather than inventing one, and prints the instructions', async (t) => {
    const dir = deployment(t);
    const where = terminal(t);
    const tailscale = joiningTailscale(t, { approved: false });
    const run = runSetup({
        dir, answers: PRIVATE, ask: where.ui, check: false, tailscale: tailscale.file, log: () => {},
    });
    // The address has to be typed, because nothing answered with one; then Enter through the rest
    // — the approach first, then the origin, the relay and the push relay.
    await press(where.input, '\r', 'house.tailnet.ts.net', '\r', '\r', '\r', '\r');
    await run;

    assert.match(tailscale.up(), /^up --hostname crossbar-finish-/, 'the join was not attempted at all');
    const seen = where.seen();
    // What is left is reported: what happened, the exact command, and what it does.
    assert.match(seen, /The login was run here and did not finish/);
    assert.match(seen, /tailscale up --hostname crossbar-finish-/, 'the one command left is not printed');
    assert.match(seen, /It prints a link; approving this machine there gives it a tailnet name/,
        'the instructions do not say what the command does');
    assert.match(seen, /re-run this install and the private address is set from that name/,
        'the instructions do not say what to do after');
    // Asked, not invented: the question is the one that reads, and what was typed is what landed.
    assert.match(seen, /◆\s+Private \(tailnet\): the address people dial over the tailnet/);
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'),
        /^NETWORK_MODE_PRIVATE_HOSTNAME=house\.tailnet\.ts\.net$/m, 'what was typed is what was written');
});
