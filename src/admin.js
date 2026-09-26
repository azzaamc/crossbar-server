'use strict';

// Operator commands.
//
// There is no admin web UI on purpose. The directory is small, whoever runs this has a
// shell, and a second network surface to secure is a second surface to get wrong. These
// commands open the same database the server uses — SQLite in WAL mode, so both can work
// at once — and the HTTP admin routes exist for the same operations when a browser is
// more convenient.
//
// Usage: node src/admin.js <command> [options]

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, applyMode, modeBlock, writtenMode, MODES, setEnvLine, verifyEnvFile, writeEnvFile } = require('./config');
const { operatorToken, OPERATOR_HEADER } = require('./identity');
const { Store } = require('./db');
const auth = require('./auth');
const { diagnose, summariseResults } = require('./diagnostics');

const USAGE = `Crossbar administration

  users                                  List the people in the directory file
  devices [--user <id>]                  List devices, optionally for one person
  enroll --user <id> [--ttl <seconds>]   Create a one-time invitation for a device
  enrollments                            List invitations and their state
  revoke-enrollment <id>                 Withdraw an invitation that has not been used
  rename-device <deviceId> <label>       Give a device a name a person recognises
  revoke-device <deviceId>               Take a device's key out of use
  remove-device <deviceId>               Take a revoked device out of the records
  status                                 Configuration and counts
  mode                                   Both configurations, and which is in force
  mode private|public                    Switch this deployment to that one
  password                               Set the console's password, prompted
  ring --from <id> --to <id>              Ring a device, to test that it does
  doctor                                 Reachability and first-install checks
`;

function parseArgs(argv) {
    const [command, ...rest] = argv;
    const options = {};
    const positional = [];
    for (let index = 0; index < rest.length; index += 1) {
        const value = rest[index];
        if (value.startsWith('--')) {
            const name = value.slice(2);
            const next = rest[index + 1];
            if (next === undefined || next.startsWith('--')) {
                options[name] = true;
            } else {
                options[name] = next;
                index += 1;
            }
        } else {
            positional.push(value);
        }
    }
    return { command, options, positional };
}

function pad(value, width) {
    const text = String(value ?? '');
    return text.length >= width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function printPeople(store) {
    const rows = store.listUsers();
    if (!rows.length) return console.log('No people are configured.');
    console.log(`${pad('ID', 14)}${pad('NAME', 22)}${pad('ADMIN', 7)}${pad('LOGIN', 34)}DEVICES  LAST AUTHENTICATED`);
    for (const row of rows) {
        console.log(
            pad(row.id, 14) + pad(row.displayName, 22) + pad(row.admin ? 'yes' : '-', 7)
            + pad(row.login, 34) + pad(row.activeDevices, 9) + (row.lastAuthenticated || 'never'),
        );
    }
}

function printDevices(store, userId = null) {
    const rows = store.allDevices(userId);
    if (!rows.length) return console.log('No devices are registered.');
    console.log(`${pad('DEVICE', 26)}${pad('OWNER', 20)}${pad('LABEL', 18)}${pad('PLATFORM', 10)}${pad('STATE', 9)}${pad('KEY', 5)}${pad('RING', 6)}LAST SEEN`);
    for (const row of rows) {
        console.log(
            pad(row.id, 26) + pad(row.userName || row.userId, 20) + pad(row.label || '-', 18)
            + pad(row.platform || '-', 10) + pad(row.status, 9) + pad(row.hasKey ? 'yes' : '-', 5)
            // Whether this phone can be rung while it is asleep. `NO` is the state that reads
            // as a broken deployment from the other end of a call, and it is not visible
            // anywhere else in this output.
            + pad(row.hasVoipToken ? 'yes' : 'NO', 6)
            + (row.lastSeenAt || 'never'),
        );
    }
}

function printEnrollments(store) {
    const now = new Date().toISOString();
    const rows = store.enrollments(now);
    if (!rows.length) return console.log('No invitations have been created.');
    console.log(`${pad('ID', 20)}${pad('FOR', 14)}${pad('STATE', 9)}${pad('EXPIRES', 26)}CREATED BY`);
    for (const row of rows) {
        console.log(
            pad(row.id, 20) + pad(row.intendedUserId || '-', 14) + pad(row.state, 9)
            + pad(row.expiresAt, 26) + (row.createdBy || 'cli'),
        );
    }
}

/** A line typed without appearing on the screen, which is what a password deserves. */
function readPassword(prompt) {
    return new Promise((resolve) => {
        process.stdout.write(prompt);
        const { stdin } = process;
        const wasRaw = Boolean(stdin.isRaw);
        if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume();
        let typed = '';

        const finish = (rest) => {
            stdin.removeListener('data', onData);
            if (stdin.isTTY) stdin.setRawMode(wasRaw);
            process.stdout.write('\n');
            // Anything typed after the newline belongs to whoever asks next — which is this
            // function again, for the confirmation — so it goes back rather than being lost.
            // Paused first: a stream that is still flowing emits what is pushed into it to a
            // listener that has just been removed, which is to say it drops it.
            stdin.pause();
            if (rest) stdin.unshift(Buffer.from(rest, 'utf8'));
            resolve(typed);
        };

        const onData = (chunk) => {
            const text = String(chunk);
            for (let index = 0; index < text.length; index += 1) {
                const character = text[index];
                if (character === '\r' || character === '\n') return finish(text.slice(index + 1));
                // Ctrl-C is a way out, and it should leave the terminal as it found it.
                if (character === '\u0003') { process.stdout.write('\n'); process.exit(130); }
                if (character === '\u007f' || character === '\b') { typed = typed.slice(0, -1); continue; }
                if (character >= ' ') typed += character;
            }
            return undefined;
        };

        stdin.on('data', onData);
    });
}

/**
 * What this deployment is missing, as a sentence, or null.
 *
 * The store opens a database inside the data directory and syncs the directory file, so a
 * command that needs it cannot run before a deployment is otherwise complete — which is
 * expected, and which is also the moment an operator is most likely to be reading this
 * output. Measured 2026-09-26, on a first install with the tree in place and no `.env` and
 * no directory file: `node src/admin.js mode private` printed `unable to open database
 * file` and nothing else. It names no path, no setting and no next step, and the same
 * failure arrives as a stack trace when it is thrown rather than said.
 *
 * The store creates the data directory itself, so absence there is not a problem; a
 * directory it cannot write is, and SQLite's message for that names neither the path nor
 * the reason. Both are said here instead.
 */
function deploymentProblem(config) {
    if (!fs.existsSync(config.envFile)) {
        return `No .env beside this process (${config.envFile}). Copy .env.example to .env — it names every setting — and fill in the block for the mode this deployment is in.`;
    }
    if (!fs.existsSync(config.directoryConfigPath)) {
        return `No directory file at ${config.directoryConfigPath}. Write one — data/directory.example.json is the shape, and it needs at least one administrator who is not suspended.`;
    }
    if (fs.existsSync(config.dataDir)) {
        try {
            fs.accessSync(config.dataDir, fs.constants.W_OK);
        } catch {
            return `The data directory ${config.dataDir} cannot be written by ${process.env.USER || 'this user'}, and the database and the backups are kept there.`;
        }
    }
    return null;
}

/** A store for a deployment that has what it needs, or a refusal that says what is missing. */
function openStore(config) {
    const problem = deploymentProblem(config);
    if (problem) throw new Error(problem);
    return new Store(config.dataDir, config.directoryConfigPath);
}

/**
 * The commands that need a database, and so a deployment that is otherwise complete.
 *
 * Everything else runs on a box that has none yet, which is the state a first install is in:
 * `mode` rewrites `.env` and `doctor` asks questions about the machine, and neither has any
 * business opening a database to do it. `doctor` opens its own inside its branch — it has to
 * *report* a database it cannot open rather than refuse over one, and what it says is the
 * sentence above rather than a SQLite string.
 */
const NEEDS_STORE = new Set([
    'users', 'devices', 'enroll', 'enrollments', 'revoke-enrollment', 'rename-device',
    'revoke-device', 'remove-device', 'status', 'ring',
]);

/**
 * The headers every request this CLI makes to the running server carries.
 *
 * The CLI asks the live process over the loopback it already treats as its proxy, and in
 * public mode that connection is not believed on the strength of a login — the server
 * demands a device key there, which a shell does not have. The derived operator token is
 * what says this is the machine talking to itself rather than a client; the login stays,
 * because it is what names the person the request is made as, exactly as in private mode.
 * A deployment with no secret derives no token, and none is sent, so nothing changes there.
 */
function operatorHeaders(config, extra = {}) {
    const token = operatorToken(config);
    return {
        'content-type': 'application/json',
        ...(token ? { [OPERATOR_HEADER]: token } : {}),
        ...extra,
    };
}

async function main(argv) {
    const { command, options, positional } = parseArgs(argv);
    if (!command || command === 'help' || command === '--help') {
        console.log(USAGE);
        return 0;
    }

    const config = loadConfig();
    // Opened only by the commands that need one, so `mode`, `password` and `doctor` work on a
    // box whose deployment is not complete yet — which is exactly when they are run.
    const store = NEEDS_STORE.has(command) ? openStore(config) : null;
    const now = new Date().toISOString();

    try {
        switch (command) {
            case 'users':
                printPeople(store);
                return 0;

            case 'devices':
                printDevices(store, typeof options.user === 'string' ? options.user : null);
                return 0;

            case 'enroll': {
                if (typeof options.user !== 'string') {
                    console.error('enroll needs --user <id>. An invitation always names the person it is for.');
                    return 1;
                }
                const result = auth.createInvitation({
                    store,
                    config,
                    now,
                    userId: options.user,
                    ttlSeconds: Number(options.ttl) || null,
                });
                if (!result.ok) {
                    console.error(`Could not create an invitation: ${result.reason}`);
                    if (result.reason === 'DEVICE_AUTH_DISABLED') {
                        console.error('Set CROSSBAR_SESSION_SECRET first; invitations are useless without it.');
                    }
                    return 1;
                }
                // The token appears here and nowhere else: only its hash is stored, so
                // this output is the one chance to hand it over.
                console.log(`Invitation ${result.enrollment.id} for ${options.user}, expires ${result.enrollment.expiresAt}`);
                console.log('Give this to the device (it accepts the JSON or just the token):');
                console.log(JSON.stringify(result.payload));
                return 0;
            }

            case 'enrollments':
                printEnrollments(store);
                return 0;

            case 'revoke-enrollment': {
                const [id] = positional;
                if (!id) { console.error('revoke-enrollment needs an invitation id.'); return 1; }
                const revoked = store.revokeEnrollment(id, now);
                console.log(revoked ? `Revoked ${id}.` : `${id} was not open; nothing to revoke.`);
                return revoked ? 0 : 1;
            }

            case 'rename-device': {
                const [deviceId, ...labelParts] = positional;
                const label = labelParts.join(' ');
                if (!deviceId || !label) { console.error('rename-device needs a device id and a label.'); return 1; }
                const renamed = store.renameDevice(deviceId, label, now);
                console.log(renamed ? `Renamed ${deviceId} to "${label}".` : `No device ${deviceId}.`);
                return renamed ? 0 : 1;
            }

            case 'revoke-device': {
                const [deviceId] = positional;
                if (!deviceId) { console.error('revoke-device needs a device id.'); return 1; }
                const device = store.deviceIdentity(deviceId);
                if (!device) { console.error(`No device ${deviceId}.`); return 1; }
                const revoked = store.revokeDevice(deviceId, now);
                // The person keeps their other devices, and their account: revoking a
                // phone is not revoking a person.
                console.log(revoked
                    ? `Revoked ${deviceId} (${device.label || 'unlabelled'}). They keep their other devices.`
                    : `${deviceId} was already revoked.`);
                return revoked ? 0 : 1;
            }

            case 'remove-device': {
                const [deviceId] = positional;
                if (!deviceId) { console.error('remove-device needs a device id.'); return 1; }
                const device = store.deviceIdentity(deviceId);
                if (!device) { console.error(`No device ${deviceId}.`); return 1; }
                if (device.status === 'active') {
                    console.error(`${deviceId} still works. Run "revoke-device ${deviceId}" first.`);
                    return 1;
                }
                const removed = store.removeDevice(deviceId);
                // What the person did in a call is recorded by user and is not touched:
                // removing a phone is not removing the calls it was in.
                console.log(removed
                    ? `Removed ${deviceId} (${device.label || 'unlabelled'}) from the records.`
                    : `No device ${deviceId}.`);
                return removed ? 0 : 1;
            }

            case 'password': {
                const file = path.resolve(process.cwd(), '.env');
                if (!fs.existsSync(file)) {
                    console.error('No .env here. Copy .env.example to .env first.');
                    return 1;
                }
                const password = await readPassword('New console password: ');
                if (password.length < 12) {
                    console.error('Use at least 12 characters: this one password is the whole of the console’s defence.');
                    return 1;
                }
                if (password !== await readPassword('Again: ')) {
                    console.error('They did not match.');
                    return 1;
                }
                writeEnvFile(file, setEnvLine(fs.readFileSync(file, 'utf8'),
                    'CROSSBAR_ADMIN_PASSWORD_HASH', auth.hashPassword(password)));
                console.log('Set, as a hash — the password itself is nowhere on this machine.');
                console.log('It takes effect on the next start:');
                console.log('  systemctl restart crossbar');
                return 0;
            }

            case 'mode': {
                const file = path.resolve(process.cwd(), '.env');
                if (!fs.existsSync(file)) {
                    console.error('No .env here. Copy .env.example to .env first.');
                    return 1;
                }
                const content = fs.readFileSync(file, 'utf8');
                const [wanted] = positional;

                if (!wanted) {
                    console.log(`${pad('', 3)}${pad('MODE', 11)}${pad('HOSTNAME', 38)}ORIGIN`);
                    for (const mode of MODES) {
                        const block = modeBlock(content, mode);
                        const active = config.networkMode === mode;
                        console.log(
                            pad(active ? '->' : '', 3) + pad(mode, 11) + pad(block.HOSTNAME || '-', 38)
                            + (block.ORIGIN || '(unset: invitations would carry the default origin)'),
                        );
                    }
                    const check = verifyEnvFile(process.cwd(), config.networkMode);
                    console.log(check.ok
                        ? `\n${config.networkMode} is in force, and loads cleanly.`
                        : `\n${config.networkMode} is in force but does not load: ${check.message}`);
                    return check.ok ? 0 : 1;
                }

                if (!MODES.includes(wanted)) {
                    console.error(`mode takes one of ${MODES.join(', ')}.`);
                    return 1;
                }
                if (wanted === writtenMode(content)) {
                    // Compared against what the *file* says, not against what the configuration
                    // resolved to. `loadConfig` defaults to private, so a fresh install's file
                    // — `deploy/.env.example`, with both blocks and no generated section — is in
                    // force as private while carrying no `CROSSBAR_NETWORK_MODE` line at all;
                    // this comparison used to call that "already in private" and write nothing.
                    // Both mode shapers run under
                    // `ExecCondition=/usr/bin/grep -qx CROSSBAR_NETWORK_MODE=<mode>` on that
                    // file, so on a fresh private install `tailscale serve` was never run and
                    // nobody on the tailnet could reach a server that was perfectly healthy on
                    // loopback. Measured on the rehearsal host, 2026-09-26.
                    console.log(`Already in ${wanted}; the file says so, and nothing has changed.`);
                    return 0;
                }

                // Written before it is checked, because the only honest test is what the
                // file says to a process starting from it — and put back if it does not
                // hold up. A switch that leaves a deployment unable to start is worse
                // than no switch at all. Both writes land on `.env` itself and keep the
                // file they replace in the data directory: the console reaches this code
                // inside the service's sandbox, which may write the file and not the
                // directory it is in, so an in-place write is the only one that gets
                // there — and the price is that a crash leaves the file half-written
                // rather than one of two whole ones, which is what `env.previous` and
                // `doctor` are for.
                writeEnvFile(file, applyMode(content, wanted));
                const check = verifyEnvFile(process.cwd(), wanted);
                if (!check.ok) {
                    writeEnvFile(file, content);
                    console.error(`Cannot switch to ${wanted}: ${check.message}`);
                    console.error(`Fill in its block in .env — NETWORK_MODE_${wanted.toUpperCase()}_HOSTNAME`
                        + ` and NETWORK_MODE_${wanted.toUpperCase()}_ORIGIN — and try again.`);
                    return 1;
                }
                console.log(`In ${wanted} from the next start:`);
                console.log('  systemctl restart crossbar');
                console.log('  (the reverse proxy too, when the two modes bind different addresses)');
                return 0;
            }

            case 'status': {
                const openEnrollments = store.enrollments(now).filter((item) => item.state === 'open');
                console.log(`Version           ${require('../package.json').version}`);
                console.log(`Mode              ${config.networkMode}`);
                console.log(`Origin            ${config.publicOrigin}`);
                console.log(`Listener          ${config.host}:${config.port}`);
                console.log(`Device auth       ${config.sessionSecret ? (config.requireDeviceAuth ? 'required' : 'available') : 'not configured'}`);
                console.log(`TURN              ${config.turn?.host ? `${config.turn.host}:${config.turn.port} relays ${config.turn.minPort}-${config.turn.maxPort}` : 'not configured'}`);
                console.log(`APNs              ${config.apnsKeyId && config.apnsTopic
                    ? `configured (${config.apnsTopic})`
                    : 'not configured — a phone with its screen off cannot be rung'}`);
                console.log(`People            ${store.listUsers().length}`);
                console.log(`Devices           ${store.allDevices().length}`);
                console.log(`Open invitations  ${openEnrollments.length}${openEnrollments.length ? ` (${openEnrollments.map((item) => item.id).join(', ')})` : ''}`);
                return 0;
            }

            case 'ring': {
                // A test call, placed *through* the running server rather than beside it.
                //
                // The live process is the one holding the sockets and the push credentials, so a
                // call made anywhere else would ring nothing: this asks it over the loopback it
                // already treats as its proxy, as the person `--from` names. That person needs a
                // login, because a login is how a request is believed here — which is why a
                // directory keeps one test person with one.
                const from = String(options.from || '');
                const to = String(options.to || positional[0] || '');
                if (!from || !to) {
                    console.error('ring needs --from <id> and --to <id>.');
                    console.error('  e.g. ring --from ringtest --to abdullah');
                    return 1;
                }
                const login = store.listUsers().find((user) => user.id === from)?.login;
                if (!store.userById(from)) {
                    console.error(`No person with the id ${from}.`);
                    return 1;
                }
                if (!login) {
                    console.error(`${from} has no login, so a request cannot be believed as them.`);
                    return 1;
                }
                const response = await fetch(`http://${config.host}:${config.port}/api/calls`, {
                    method: 'POST',
                    headers: operatorHeaders(config, { 'Tailscale-User-Login': login }),
                    body: JSON.stringify({ inviteeIds: [to], video: true }),
                });
                const body = await response.text();
                if (!response.ok) {
                    console.error(`The server refused it: ${body.slice(0, 240)}`);
                    return 1;
                }
                console.log(`Ringing ${to} as ${from}. It rings for ${config.callRingSeconds} seconds, then counts as missed.`);
                return 0;
            }

            case 'doctor': {
                // The store is a check like any other here, and on a first install it is the
                // one that fails first: there is no directory file yet. It is reported on its
                // own line with the sentence that says which path and what to do, rather than
                // thrown before anything else has been asked.
                let store = null;
                let storeError = null;
                try {
                    store = openStore(config);
                } catch (error) {
                    storeError = String(error && error.message) || 'the database could not be opened';
                }
                try {
                    const results = await diagnose({ config, store, storeError });
                    for (const result of results) {
                        // Three levels, not two. A warning is a check that passed and still has
                        // something to say — a name in `.env` that nothing reads, say — and it must
                        // not fail this command: a first install with a stray line is not broken,
                        // and a command that says it is teaches the operator to ignore it. What it
                        // must do is be seen, which is why it is its own word rather than a detail
                        // under OK.
                        const level = result.warn ? 'WARN' : (result.ok ? 'OK  ' : 'FAIL');
                        console.log(`${level}  ${pad(result.name, 22)}${result.detail}`);
                    }
                    // Counted at the end as well as marked above: the lines are read from the top,
                    // and a warning that scrolled off the top is a warning nobody saw. Warnings do
                    // not decide the exit code — see `summariseResults` — or a first install with a
                    // stray line would read as broken.
                    const { failed, warned } = summariseResults(results);
                    if (warned || failed) console.log(`\n${failed} failed, ${warned} warned.`);
                    return failed ? 1 : 0;
                } finally {
                    if (store) store.close();
                }
            }

            default:
                console.error(`Unknown command: ${command}\n`);
                console.log(USAGE);
                return 1;
        }
    } finally {
        if (store) store.close();
    }
}

main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
        console.error(String(error && error.message) || error);
        process.exitCode = 1;
    });
