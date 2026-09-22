'use strict';

// Operator commands.
//
// There is no admin web UI on purpose. The household is small, whoever runs this has a
// shell, and a second network surface to secure is a second surface to get wrong. These
// commands open the same database the server uses — SQLite in WAL mode, so both can work
// at once — and the HTTP admin routes exist for the same operations when a browser is
// more convenient.
//
// Usage: node src/admin.js <command> [options]

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadConfig, applyMode, modeBlock, MODES } = require('./config');
const { Store } = require('./db');
const auth = require('./auth');
const { diagnose } = require('./diagnostics');

const USAGE = `Crossbar administration

  users                                  List the people in the household file
  devices [--user <id>]                  List devices, optionally for one person
  enroll --user <id> [--ttl <seconds>]   Create a one-time invitation for a device
  enrollments                            List invitations and their state
  revoke-enrollment <id>                 Withdraw an invitation that has not been used
  rename-device <deviceId> <label>       Give a device a name a person recognises
  revoke-device <deviceId>               Take a device's key out of use
  status                                 Configuration and counts
  mode                                   Both configurations, and which is in force
  mode private|public                    Switch this deployment to that one
  doctor                                 Reachability checks
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
    console.log(`${pad('DEVICE', 26)}${pad('OWNER', 20)}${pad('LABEL', 18)}${pad('PLATFORM', 10)}${pad('STATE', 9)}${pad('KEY', 5)}LAST SEEN`);
    for (const row of rows) {
        console.log(
            pad(row.id, 26) + pad(row.userName || row.userId, 20) + pad(row.label || '-', 18)
            + pad(row.platform || '-', 10) + pad(row.status, 9) + pad(row.hasKey ? 'yes' : '-', 5)
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

/**
 * What the selected configuration makes of itself, read by a child process with nothing
 * but the file in its environment — which is the question a restart asks. Inheriting this
 * process's environment would answer a different one: this process read `.env` when it
 * started, and `loadDotEnv` never overwrites a variable that is already set, so anything
 * held here would hide what the file now says.
 */
function loadFresh(cwd, mode) {
    const result = spawnSync(process.execPath, [
        '-e', `require(${JSON.stringify(path.join(__dirname, 'config.js'))}).loadConfig()`,
    ], {
        cwd,
        env: { PATH: process.env.PATH, CROSSBAR_NETWORK_MODE: mode },
        encoding: 'utf8',
    });
    const stderr = (result.stderr || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const failure = stderr.find((line) => /Error: /.test(line)) || stderr[stderr.length - 1] || '';
    return { ok: result.status === 0, message: failure.replace(/^\w*Error: /, '') };
}

async function main(argv) {
    const { command, options, positional } = parseArgs(argv);
    if (!command || command === 'help' || command === '--help') {
        console.log(USAGE);
        return 0;
    }

    const config = loadConfig();
    const store = new Store(config.dataDir, config.familyConfigPath);
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
                    const check = loadFresh(process.cwd(), config.networkMode);
                    console.log(check.ok
                        ? `\n${config.networkMode} is in force, and loads cleanly.`
                        : `\n${config.networkMode} is in force but does not load: ${check.message}`);
                    return check.ok ? 0 : 1;
                }

                if (!MODES.includes(wanted)) {
                    console.error(`mode takes one of ${MODES.join(', ')}.`);
                    return 1;
                }
                if (wanted === config.networkMode) {
                    console.log(`Already in ${wanted}; nothing to change.`);
                    return 0;
                }

                // Written before it is checked, because the only honest test is what the
                // file says to a process starting from it — and put back if it does not
                // hold up. A switch that leaves a deployment unable to start is worse
                // than no switch at all.
                fs.writeFileSync(file, applyMode(content, wanted));
                const check = loadFresh(process.cwd(), wanted);
                if (!check.ok) {
                    fs.writeFileSync(file, content);
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
                console.log(`Mode              ${config.networkMode}`);
                console.log(`Origin            ${config.publicOrigin}`);
                console.log(`Listener          ${config.host}:${config.port}`);
                console.log(`Device auth       ${config.sessionSecret ? (config.requireDeviceAuth ? 'required' : 'available') : 'not configured'}`);
                console.log(`TURN              ${config.turn?.host ? `${config.turn.host}:${config.turn.port} relays ${config.turn.minPort}-${config.turn.maxPort}` : 'not configured'}`);
                console.log(`People            ${store.listUsers().length}`);
                console.log(`Devices           ${store.allDevices().length}`);
                console.log(`Open invitations  ${openEnrollments.length}${openEnrollments.length ? ` (${openEnrollments.map((item) => item.id).join(', ')})` : ''}`);
                return 0;
            }

            case 'doctor': {
                const results = await diagnose({ config, store });
                for (const result of results) {
                    console.log(`${result.ok ? 'OK  ' : 'FAIL'}  ${pad(result.name, 22)}${result.detail}`);
                }
                return results.every((result) => result.ok) ? 0 : 1;
            }

            default:
                console.error(`Unknown command: ${command}\n`);
                console.log(USAGE);
                return 1;
        }
    } finally {
        store.close();
    }
}

main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
        console.error(String(error && error.message) || error);
        process.exitCode = 1;
    });
