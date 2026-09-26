'use strict';

// The installer's private front door, in the order that decides what lands in `.env`.
//
// The private address is the one answer that already exists on the machine — it is the name
// Tailscale gives this host — and there is no name until a login has happened. So the installer
// decides an order: with an auth key it logs in before the wizard's questions, so the wizard's
// derived default is the real name; without one it cannot, and the front door's report corrects
// `.env` once a login has happened. Both halves write `NETWORK_MODE_PRIVATE_ORIGIN`, which is what
// an invitation carries, so getting this wrong is an invitation that opens nowhere.
//
// Everything here is a real `--dry-run` of `scripts/install.sh` against a scratch prefix: reads
// are made and changes are printed, never executed. The tailscale command is injected through
// `TAILSCALE_BIN`, the seam `scripts/lib/deploy.sh` takes instead of reaching for `tailscale`
// itself — so this needs no Tailscale and no systemd, which is what lets it run on a workstation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INSTALL = path.join(__dirname, '..', 'scripts', 'install.sh');
const EXAMPLE = path.join(__dirname, '..', '.env.example');

/** The name a first install with no login writes: the guess this whole file is about. */
const GUESS = 'guess.tail1234.ts.net';
/** The name the machine actually answers at, which the tailnet gives it. */
const REAL = 'real-box.tail1234.ts.net';

/**
 * The stand-in for the tailscale CLI, injected as `TAILSCALE_BIN`. It answers the one read the
 * installer makes — `status --json`'s `Self.DNSName`, with the trailing dot a real one has — and
 * an empty `TAILNET_NAME` is the daemon not being logged in, which is an ordinary answer.
 */
const STUB = `#!/bin/sh
if [ "$1" = 'status' ] && [ "$2" = '--json' ]; then
    if [ -n "\${TAILNET_NAME:-}" ]; then
        printf '{"Self":{"DNSName":"%s."}}\\n' "$TAILNET_NAME"
    else
        printf '{"Self":{}}\\n'
    fi
fi
`;

/** A scratch deployment holding the guess, and the two files the dry run reads. */
function scratch(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-install-order-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prefix = path.join(root, 'prefix');
    fs.mkdirSync(path.join(prefix, 'data'), { recursive: true });
    fs.copyFileSync(EXAMPLE, path.join(prefix, '.env'));
    fs.appendFileSync(path.join(prefix, '.env'),
        `NETWORK_MODE_PRIVATE_HOSTNAME=${GUESS}\nNETWORK_MODE_PRIVATE_ORIGIN=https://${GUESS}\n`);
    const answers = path.join(root, 'answers.json');
    fs.writeFileSync(answers, JSON.stringify({ mode: 'private' }));
    const tailscale = path.join(root, 'tailscale');
    fs.writeFileSync(tailscale, STUB, { mode: 0o755 });
    return { prefix, answers, tailscale };
}

/** The whole transcript of one dry run, with the machine's tailnet name as the given one. */
function dryRun(files, tailnetName, extra = []) {
    const run = spawnSync('bash', [INSTALL, '--dry-run', '--prefix', files.prefix,
        '--answers', files.answers, ...extra], {
        encoding: 'utf8',
        env: { ...process.env, TAILSCALE_BIN: files.tailscale, TAILNET_NAME: tailnetName },
    });
    assert.equal(run.status, 0, `install.sh exited ${run.status}:\n${run.stderr}`);
    return `${run.stdout}${run.stderr}`;
}

/** Where a line containing `needle` is, or `-1` — for "before" and "not at all". */
const lineOf = (text, needle) => text.split('\n').findIndex((line) => line.includes(needle));

/** Every wizard run in a transcript: the one that writes the files, and a correction after it. */
const wizardRuns = (text) => text.split('\n').filter((line) => line.includes('src/admin.js setup'));

test('with an auth key, the login is printed before the wizard asks anything', (t) => {
    const text = dryRun(scratch(t), REAL, ['--tailscale-authkey', 'tskey-auth-test']);
    const login = lineOf(text, 'TS_AUTHKEY=<hidden>');
    const wizard = lineOf(text, 'src/admin.js setup --answers');
    assert.ok(login >= 0, `no login step in:\n${text}`);
    assert.ok(wizard >= 0, `no wizard step in:\n${text}`);
    assert.ok(login < wizard, `the login is not before the wizard (login ${login}, wizard ${wizard})`);
    // The one thing `--tailscale-authkey` must never do: the key reaches Tailscale through
    // TS_AUTHKEY, so neither argv nor the transcript carries it.
    assert.ok(!text.includes('tskey-auth-test'), 'the auth key is in the transcript');
    assert.match(text.split('\n')[login], /up --operator=\S+/,
        'the deployment account is not named the tailnet operator, so the account cannot read the name');
});

test('without a key, a name that disagrees is offered and corrected through the wizard', (t) => {
    const text = dryRun(scratch(t), REAL);
    // The questions keep their place without a key: the install happens after them, not before.
    assert.ok(lineOf(text, 'src/admin.js setup --answers') < lineOf(text, 'systemctl enable --now tailscaled'));
    assert.ok(text.includes(`the private address in .env is ${GUESS}, and this machine answers at ${REAL}:`),
        `no correction offer in:\n${text}`);
    assert.ok(text.includes('an invitation carries that address'), 'the offer does not say why it matters');
    // One call, into the wizard that keeps every other value and every secret — not a second writer,
    // and not the answers file again (which could carry the wrong address, or new secrets).
    const runs = wizardRuns(text);
    assert.equal(runs.length, 2, `expected one setup run and one correction:\n${text}`);
    assert.ok(runs[1].includes(`--no-ask --private-hostname ${REAL} --private-origin https://${REAL}`),
        `the correction does not carry the discovered name:\n${runs[1]}`);
    assert.ok(!runs[1].includes('--answers'), `the correction re-applies the answers file:\n${runs[1]}`);
});

test('without a key, a name that agrees leaves the file alone', (t) => {
    const text = dryRun(scratch(t), GUESS);
    assert.ok(!text.includes('Running the wizard again'), `a correction was offered for an agreeing name:\n${text}`);
    assert.ok(!text.includes('the private address in .env is'), 'a mismatch was reported for an agreeing name');
    assert.equal(wizardRuns(text).length, 1, `the wizard was re-run for an agreeing name:\n${text}`);
});

test('without a key and not logged in, the report names the one command left', (t) => {
    const text = dryRun(scratch(t), '');
    assert.ok(text.includes("One step here is still a person's"), 'the login is not named as the person\'s');
    assert.ok(text.includes('up --operator='), 'the login command is not printed');
    assert.ok(text.includes('but this machine is not logged in yet'), `the final report is silent:\n${text}`);
    assert.ok(text.includes('The one command left is:'), 'the final report does not name the one command');
    assert.ok(text.includes('Re-run this installer afterwards'), 'the final report does not say how it is fixed');
});
