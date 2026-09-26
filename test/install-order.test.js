'use strict';

// The installer's Tailscale work: what is done before the wizard asks anything, what the wizard
// itself does with it, and what is left for the front door afterwards.
//
// The join is the **wizard's**, because the wizard is the process that runs as the deployment's
// account and the private address is the name that account's login gives the machine. So the
// installer's part is the preparation — Tailscale installed, `tailscaled` started, and the account
// named the daemon's **operator**, without which the account cannot join anything — done before the
// mode question, since nothing can install as root from inside the wizard. The mode question then
// decides: a mode set that includes private makes the wizard run `tailscale up --hostname <the
// deployment's name>` (whose approval link appears in this terminal when there is one, and with
// `TS_AUTHKEY` when a key was given), read `Self.DNSName` back, and offer that name as the private
// address.
//
// What is left for the front door is the safety net: the same login attempted once more for a run
// the wizard could not join from, and the machine's own name read back to correct `.env` through
// the wizard when the two disagree. `--hostname` — the deployment's own name, the basename of
// `--prefix`, unless `--tailscale-hostname` says otherwise — is what keeps a login from joining
// under whatever the host is called where it is hosted (`srv2011992` on a VPS), since that
// provider's name is what an invitation would otherwise carry.
//
// A run that cannot join must never stop the install: with no terminal it is not attempted at all,
// and the person is handed the exact command with what it will do.
//
// Everything here is driven through the `TAILSCALE_BIN` seam `scripts/lib/deploy.sh` takes instead
// of reaching for `tailscale` itself — so this needs no Tailscale and no systemd, which is what lets
// it run on a workstation. The `--dry-run` tests go through `scripts/install.sh`; the login-failure
// test drives `install_front_door` directly, because a real run of `install.sh` needs root and
// systemd and the point is what the *function* does when `tailscale up` fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const INSTALL = path.join(ROOT, 'scripts', 'install.sh');
const EXAMPLE = path.join(ROOT, '.env.example');

/** The name a first install writes when the wizard had no tailnet name to offer. */
const GUESS = 'guess.tail1234.ts.net';
/** The name the machine actually answers at, which the tailnet gives it. */
const REAL = 'real-box.tail1234.ts.net';

/**
 * The stand-in for the tailscale CLI, injected as `TAILSCALE_BIN`. It answers the two calls the
 * installer makes — `status --json`'s `Self.DNSName` (with the trailing dot a real one has) and
 * `up` — and an empty name is the daemon not being logged in, which is an ordinary answer.
 *
 * `up` succeeds only when `TAILSCALE_UP_OK=1`, and on success it records the name in
 * `TAILSCALE_STATE`; `status` then answers from that file, which is what Tailscale does after the
 * machine is approved. That is how the login-failure test drives a login that fails and a login
 * that finishes.
 */
const STUB = `#!/bin/sh
state="\${TAILSCALE_STATE:-/dev/null}"
if [ "$1" = 'up' ]; then
    if [ "\${TAILSCALE_UP_OK:-}" = '1' ]; then
        printf '%s' "\${TAILSCALE_NAME_AFTER:-}" > "$state"
        exit 0
    fi
    printf 'the approval was declined\\n' >&2
    exit 1
fi
if [ "$1" = 'status' ] && [ "$2" = '--json' ]; then
    name="\${TAILNET_NAME:-}"
    if [ -f "$state" ]; then name="$(cat "$state")"; fi
    if [ -n "$name" ]; then
        printf '{"Self":{"DNSName":"%s."}}\\n' "$name"
    else
        printf '{"Self":{}}\\n'
    fi
    exit 0
fi
`;

/**
 * A scratch deployment holding the wizard's guess, and the two files the dry run reads. `name` is
 * the prefix's own directory name, which is what the login names the node after unless it is told
 * otherwise; `hostname` is the private address `.env` already holds, which on a first install is a
 * guess rather than the name the machine answers at.
 */
function scratch(t, name = 'prefix', hostname = GUESS) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-install-order-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prefix = path.join(root, name);
    fs.mkdirSync(path.join(prefix, 'data'), { recursive: true });
    fs.copyFileSync(EXAMPLE, path.join(prefix, '.env'));
    fs.appendFileSync(path.join(prefix, '.env'),
        `NETWORK_MODE_PRIVATE_HOSTNAME=${hostname}\nNETWORK_MODE_PRIVATE_ORIGIN=https://${hostname}\n`);
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

/** The login line the installer would run itself, or the command it leaves a person. */
const commandLines = (text, needle) => text.split('\n').filter((line) => line.includes(needle));

/**
 * `install_front_door` run for real, against a scratch prefix: Tailscale is the stub, `systemctl`
 * is a stub on PATH, and nothing else is reached. Returns the combined transcript and exit status.
 * This is how the login-failure path is proven, because a real `install.sh` needs root and systemd.
 */
function frontDoor(t, { tailnetName = '', upOk = false, authkey = 'tskey-auth-test', hostname = '' } = {}) {
    const files = scratch(t, 'crossbar-dev', hostname || GUESS);
    const stub = path.join(path.dirname(files.tailscale), 'systemctl');
    fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const script = [
        'set -euo pipefail',
        `. ${path.join(ROOT, 'scripts', 'lib', 'deploy.sh')}`,
        'DRY_RUN=0',
        `PREFIX=${JSON.stringify(files.prefix)}`,
        'CROSSBAR_USER=admin',
        `NODE_BIN=${JSON.stringify(process.execPath)}`,
        `TAILSCALE_BIN=${JSON.stringify(files.tailscale)}`,
        'TAILSCALE_HOSTNAME=crossbar-dev',
        `export PATH=${JSON.stringify(path.dirname(stub))}:$PATH`,
        `install_front_door '' ${JSON.stringify(authkey)}`,
        'printf "FRONT-DOOR-OK\\n"',
    ].join('\n');
    const run = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, TAILNET_NAME: tailnetName, TAILSCALE_UP_OK: upOk ? '1' : '',
            TAILSCALE_STATE: path.join(path.dirname(files.tailscale), 'state'),
            TAILSCALE_NAME_AFTER: tailnetName },
    });
    return { ...run, text: `${run.stdout}${run.stderr}`, files };
}

test('Tailscale is prepared before the questions: installed, started, and the account made its operator', (t) => {
    const text = dryRun(scratch(t), '');
    const wizard = lineOf(text, 'src/admin.js setup --answers');
    const enable = lineOf(text, 'systemctl enable --now tailscaled');
    const operator = lineOf(text, 'set --operator=admin');
    assert.ok(wizard >= 0, `no wizard step in:\n${text}`);
    assert.ok(enable >= 0, `no tailscaled step in:\n${text}`);
    assert.ok(operator >= 0, `the account is not named the daemon's operator:\n${text}`);
    // The wizard joins the tailnet itself, and it can only do that as the operator, so all three
    // are done before the question that decides whether any of it is used.
    assert.ok(enable < wizard, `tailscaled is started after the mode is known (${enable}, ${wizard})`);
    assert.ok(operator < wizard, `the operator is named after the mode is known (${operator}, ${wizard})`);

    // And the installation itself, when Tailscale is not on the host: the same step, from its own
    // script, still before the wizard.
    const missing = dryRun({ ...scratch(t), tailscale: '/nonexistent/tailscale' }, '');
    const install = lineOf(missing, 'curl -fsSL https://tailscale.com/install.sh | sh');
    assert.ok(install >= 0, `Tailscale would not be installed:\n${missing}`);
    assert.ok(install < lineOf(missing, 'src/admin.js setup --answers'),
        `Tailscale is installed after the mode is known:\n${missing}`);
});

test('with an auth key, the key travels with the wizard — which is where the login runs', (t) => {
    const text = dryRun(scratch(t, 'crossbar-dev'), '', ['--tailscale-authkey', 'tskey-auth-test']);
    const logins = commandLines(text, 'TS_AUTHKEY=<hidden>');
    assert.match(logins[0] ?? '', /src\/admin\.js setup --answers/,
        `the key does not reach the wizard's own join:\n${text}`);
    assert.match(logins[0] ?? '', /TAILSCALE_HOSTNAME=crossbar-dev/, 'the join is not told what to name the node');
    assert.ok(!text.includes('tskey-auth-test'), 'the auth key is in the transcript');
    // The front door is the safety net behind it, and keeps naming the node — for a run whose join
    // could not finish.
    assert.match(logins[1] ?? '', /up --operator=\S+/, 'the fallback login is not run as the operator');
    assert.match(logins[1] ?? '', /--hostname crossbar-dev$/, `the fallback login does not name the node:\n${logins[1]}`);
});

test('--tailscale-hostname is the name the join uses instead', (t) => {
    const text = dryRun(scratch(t, 'crossbar-dev'), '',
        ['--tailscale-authkey', 'tskey-auth-test', '--tailscale-hostname', 'gateway']);
    const logins = commandLines(text, 'TS_AUTHKEY=<hidden>');
    assert.match(logins[0] ?? '', /TAILSCALE_HOSTNAME=gateway\b/, `the override did not reach the wizard:\n${logins[0]}`);
    assert.match(logins[1] ?? '', /--hostname gateway$/, `the override did not reach the login:\n${logins[1]}`);
    assert.ok(!text.includes('TAILSCALE_HOSTNAME=crossbar-dev'),
        `the deployment's own name is still on the join:\n${text}`);
});

test('a prefix whose own name is not a hostname is derived into one', (t) => {
    // `require_path` allows capitals, `_` and `.` in a directory name, and none of those is what
    // Tailscale answers at, so this default is reduced to a DNS label rather than joined raw.
    const text = dryRun(scratch(t, 'Crossbar_Dev.v2'), '', ['--tailscale-authkey', 'tskey-auth-test']);
    assert.match(commandLines(text, 'TS_AUTHKEY=<hidden>')[0] ?? '', /TAILSCALE_HOSTNAME=crossbar-dev-v2\b/,
        `the prefix was not derived into a hostname:\n${text}`);
});

test('a --tailscale-hostname that is not a hostname is refused, not reduced', (t) => {
    const files = scratch(t);
    const run = spawnSync('bash', [INSTALL, '--dry-run', '--prefix', files.prefix, '--answers',
        files.answers, '--tailscale-authkey', 'tskey-auth-test', '--tailscale-hostname', 'Gate_way'], {
        encoding: 'utf8',
        env: { ...process.env, TAILSCALE_BIN: files.tailscale, TAILNET_NAME: '' },
    });
    assert.notEqual(run.status, 0, `a name that is not a hostname was accepted:\n${run.stdout}`);
    assert.match(run.stderr, /--tailscale-hostname must be a hostname/);
    assert.ok(!run.stdout.includes('TS_AUTHKEY'), `something ran before the refusal:\n${run.stdout}`);
});

test('without a key and no terminal, the login is not attempted and the instructions are printed', (t) => {
    const text = dryRun(scratch(t, 'crossbar-dev'), '');
    // Not attempted: no command the installer would run, and no key.
    assert.equal(commandLines(text, 'TS_AUTHKEY=<hidden>').length, 0, `a login was attempted:\n${text}`);
    assert.ok(!text.includes('logging this machine in:'), `the login was run without a terminal:\n${text}`);
    // The instructions: the exact command, what it does, and that a re-run finishes it.
    assert.ok(text.includes('    sudo ') && text.includes('up --operator=admin --hostname crossbar-dev'),
        `the login command is not printed:\n${text}`);
    assert.ok(text.includes('That prints a link and waits'), 'the instructions do not say what the command does');
    assert.ok(text.includes('open it and approve this machine'), 'the instructions do not say to approve the machine');
    assert.ok(text.includes('Then run this installer'), 'the instructions do not say what to do after');
});

test('without a key, a name that disagrees is offered and corrected through the wizard', (t) => {
    const text = dryRun(scratch(t), REAL);
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

test('without a key and not logged in, the report and the final report say the login is left', (t) => {
    const text = dryRun(scratch(t, 'crossbar-dev'), '');
    assert.ok(text.includes("One step here is still a person's"), 'the login is not named as a person\'s step');
    assert.ok(text.includes('There is no terminal here to show Tailscale'), `the reason is not said:\n${text}`);
    // The final report states what happened, and reuses the same instruction block.
    assert.ok(text.includes('but this machine is not logged in yet'), `the final report is silent:\n${text}`);
    assert.ok(text.includes('up --operator=admin --hostname crossbar-dev'), 'the final report does not name the command');
    assert.ok(text.includes('Then run this installer'), 'the final report does not say how it is fixed');
});

test('the login the installer leaves for a person is the same one it would have run', (t) => {
    const files = scratch(t, 'crossbar-dev');
    const text = dryRun(files, '');
    // Both places that name it — the front door's report and the install's final report — carry the
    // deployment's own name, so a person who runs it joins under the address this install wants.
    assert.ok(text.includes(`    sudo ${files.tailscale} up --operator=admin --hostname crossbar-dev`),
        `the person's login does not name the node:\n${text}`);
});

test('without a key, a name the person set is the one their own login gives', (t) => {
    const files = scratch(t, 'crossbar-dev');
    const text = dryRun(files, '', ['--tailscale-hostname', 'gateway']);
    assert.ok(text.includes(`    sudo ${files.tailscale} up --operator=admin --hostname gateway`),
        `the person's login does not name the node:\n${text}`);
});

test('a login that fails leaves the install standing, and the report says so', (t) => {
    const { status, text } = frontDoor(t, { tailnetName: '', upOk: false });
    assert.equal(status, 0, `a failed login stopped the install:\n${text}`);
    assert.ok(text.includes('FRONT-DOOR-OK'), `the front door did not finish:\n${text}`);
    assert.ok(text.includes('The login was run here and did not finish'), `the failure is not reported:\n${text}`);
    // The instruction block, exactly as a person reads it.
    assert.ok(text.includes('    sudo ') && text.includes('up --operator=admin --hostname crossbar-dev'),
        `the instruction block is not printed:\n${text}`);
    assert.ok(text.includes('That prints a link and waits'), `the instruction block is not the real one:\n${text}`);
    assert.ok(text.includes('open it and approve this machine'), 'the instructions do not say to approve the machine');
    assert.ok(text.includes('Then run this installer'), 'the instructions do not say what to do after');
});

test('a login that finishes reads the name back and corrects the address', (t) => {
    // `.env` holds the wizard's guess; the stub joins as `crossbar-dev` once approved. The front
    // door must read that back and correct `.env` to the machine's own address — the correction is
    // the whole reason the login can run after the wizard. The wizard itself is stood in for, so
    // this proves the front door's call and not a second setup run.
    const files = scratch(t, 'crossbar-dev', GUESS);
    const dir = path.dirname(files.tailscale);
    const stub = path.join(dir, 'systemctl');
    fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const script = [
        'set -euo pipefail',
        `. ${path.join(ROOT, 'scripts', 'lib', 'deploy.sh')}`,
        'DRY_RUN=0',
        `PREFIX=${JSON.stringify(files.prefix)}`,
        'CROSSBAR_USER=admin',
        `NODE_BIN=${JSON.stringify(process.execPath)}`,
        `TAILSCALE_BIN=${JSON.stringify(files.tailscale)}`,
        'TAILSCALE_HOSTNAME=crossbar-dev',
        `export PATH=${JSON.stringify(dir)}:$PATH`,
        // The correction runs the wizard; here it only has to be seen to be asked for, with the
        // machine's own name.
        'run_setup_wizard_correction() { printf "CORRECTION %s\\n" "$1"; }',
        'install_private_front_door "tskey-auth-test"',
        'report_private_front_door "tskey-auth-test"',
        'printf "FRONT-DOOR-OK\\n"',
    ].join('\n');
    const run = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, TAILNET_NAME: '', TAILSCALE_UP_OK: '1',
            TAILSCALE_STATE: path.join(dir, 'state'),
            TAILSCALE_NAME_AFTER: 'crossbar-dev.tail1234.ts.net' },
    });
    const text = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, `the front door exited non-zero:\n${text}`);
    assert.ok(text.includes('this machine is on the tailnet as crossbar-dev.tail1234.ts.net'),
        `the login did not report a name:\n${text}`);
    assert.ok(text.includes('CORRECTION crossbar-dev.tail1234.ts.net'),
        `the address was not corrected to the machine's own name:\n${text}`);
    assert.ok(!text.includes('did not finish'), `a finished login was reported as failed:\n${text}`);
});
