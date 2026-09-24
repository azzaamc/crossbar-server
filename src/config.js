'use strict';

// Configuration for the Crossbar server. Every process.env read lives here, so the
// set of things that can change behaviour is one file long.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function loadDotEnv(filePath) {
    if (!fs.existsSync(filePath)) return;
    for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const equals = line.indexOf('=');
        if (equals < 1) continue;
        const key = line.slice(0, equals).trim();
        if (process.env[key] !== undefined) continue;
        let value = line.slice(equals + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[key] = value;
    }
}

/** The file this configuration was read from — what a mode switch or a setting rewrites. */
const ENV_FILE = path.resolve(process.cwd(), '.env');
loadDotEnv(ENV_FILE);

function bool(name, fallback = false) {
    const value = process.env[name];
    if (value === undefined || value === '') return fallback;
    return /^(1|true|yes)$/i.test(value);
}

function integer(name, fallback, min, max) {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function text(name, fallback = '') {
    const value = process.env[name];
    return value === undefined ? fallback : String(value).trim();
}

function httpsOrigin(value, name) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${name} must be an absolute URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`${name} must be http(s)`);
    }
    return url.origin;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function loadConfig() {
    const host = text('HOST', '127.0.0.1');
    // The listener may only ever be loopback: the identity header is trusted because
    // it arrives from the local proxy, and that trust is worthless if anything else
    // can reach the same port.
    if (!LOOPBACK.has(host)) throw new Error('HOST must remain loopback-only');

    const allowDevIdentity = bool('ALLOW_DEV_IDENTITY', false);
    if (allowDevIdentity && !LOOPBACK.has(host)) {
        throw new Error('ALLOW_DEV_IDENTITY requires a loopback listener');
    }

    // ── Network mode ────────────────────────────────────────────────────────────
    //
    // How this deployment is reached, which decides what about a request may be
    // believed. `private` is the tailnet: a local proxy injects an identity header,
    // and the loopback listener is what makes that header mean anything. `public` is
    // the open internet behind a reverse proxy on this same host: nothing in the
    // request is believed, and a device proves itself with a key it holds.
    //
    // The mode changes what is trusted, never which code runs: both modes are the
    // same server, the same signalling and the same database. It is one line in
    // `.env`, and both configurations are kept there at once, so switching is one
    // command and neither configuration is a different build.
    const networkMode = text('CROSSBAR_NETWORK_MODE', 'private').toLowerCase();
    if (networkMode !== 'private' && networkMode !== 'public') {
        throw new Error('CROSSBAR_NETWORK_MODE must be private or public');
    }

    // Where this deployment is, per mode. Both configurations live in `.env` at once
    // — `node src/admin.js mode` moves between them — so the address a mode needs is
    // named for that mode, and the plain names stay as overrides for a run that is
    // not a deployment (a laptop, a test).
    const modeKey = (name) => `NETWORK_MODE_${networkMode.toUpperCase()}_${name}`;
    const modeValue = (name, fallback = '') => text(modeKey(name), text(name, fallback));

    const publicOrigin = httpsOrigin(
        modeValue('ORIGIN', `http://${host}:${integer('PORT', 3010, 1, 65535)}`),
        `PUBLIC_ORIGIN or ${modeKey('ORIGIN')}`,
    );

    const publicHostname = modeValue('HOSTNAME').toLowerCase();
    if (networkMode === 'public') {
        if (!publicHostname) {
            throw new Error(`${modeKey('HOSTNAME')} (or CROSSBAR_PUBLIC_HOSTNAME) is required in public mode: it is the host invitations send people to`);
        }
        // The origin handed to clients inside a join URL has to be the address they
        // reached this server on. Getting this wrong sends every invitation to a host
        // that does not answer, and it fails at the worst moment — mid-call.
        if (new URL(publicOrigin).hostname.toLowerCase() !== publicHostname) {
            throw new Error('PUBLIC_ORIGIN must name CROSSBAR_PUBLIC_HOSTNAME in public mode');
        }
        if (bool('ALLOW_DEV_IDENTITY', false)) {
            throw new Error('ALLOW_DEV_IDENTITY must be off in public mode: it accepts a claimed identity');
        }
    }

    // The identity header a local proxy injects. Believed only in private mode: on the
    // public internet the same header can simply be typed by whoever is calling, and
    // the reverse proxy strips it for exactly that reason. The default follows the mode
    // — off in public, on in private — and asking for it in public mode is refused
    // rather than quietly ignored, because someone who set it meant something by it.
    const trustTailscaleHeaders = bool('TRUST_TAILSCALE_HEADERS', networkMode === 'private');
    if (networkMode === 'public' && trustTailscaleHeaders) {
        throw new Error('TRUST_TAILSCALE_HEADERS must be off in public mode: the header is client-supplied there');
    }

    // ── Device identity ─────────────────────────────────────────────────────────
    //
    // Crossbar's own authentication: a per-device key, enrolled once, used to answer
    // a challenge. It is the canonical application identity in both modes; the tailnet
    // header is an additional trust signal where it exists, never the thing that
    // decides who someone is.
    //
    // Off by default in private mode because the devices that exist today have no key
    // yet, and switching it on stops them connecting. On by default in public mode
    // because reachability there means nothing at all.
    const requireDeviceAuth = bool('CROSSBAR_REQUIRE_DEVICE_AUTH', networkMode === 'public');
    const sessionSecret = text('CROSSBAR_SESSION_SECRET', '');
    if (requireDeviceAuth && !sessionSecret) {
        throw new Error('CROSSBAR_REQUIRE_DEVICE_AUTH needs CROSSBAR_SESSION_SECRET to sign sessions with');
    }

    const stunUrl = text('ICE_STUN_URL', 'stun:stun.l.google.com:19302');
    const turnHost = text('CROSSBAR_TURN_HOST', '');
    const turnPort = integer('CROSSBAR_TURN_PORT', 3478, 1, 65535);
    const turnMinPort = integer('CROSSBAR_TURN_MIN_PORT', 49160, 1024, 65535);
    const turnMaxPort = integer('CROSSBAR_TURN_MAX_PORT', 49200, 1024, 65535);
    const turnSharedSecret = text('CROSSBAR_TURN_SHARED_SECRET', '');
    if (turnHost && !turnSharedSecret) {
        throw new Error('CROSSBAR_TURN_HOST needs CROSSBAR_TURN_SHARED_SECRET: clients get temporary credentials, never a static one');
    }
    if (turnMaxPort < turnMinPort) {
        throw new Error('CROSSBAR_TURN_MAX_PORT must not be below CROSSBAR_TURN_MIN_PORT');
    }

    const turnUrl = text('ICE_TURN_URL', '');
    const turnUsername = text('ICE_TURN_USERNAME', '');
    const turnCredential = text('ICE_TURN_CREDENTIAL', '');

    return Object.freeze({
        host,
        port: integer('PORT', 3010, 0, 65535),
        publicOrigin,

        // Files
        dataDir: path.resolve(text('DATA_DIR', './data')),
        familyConfigPath: path.resolve(text('FAMILY_CONFIG_PATH', './data/family.json')),
        webRoot: path.resolve(text('WEB_ROOT', './public')),

        // Transport and trust
        networkMode,
        publicHostname,
        trustTailscaleHeaders,

        // Identity
        // A login that arrives from the tailnet is enrolled on first sight, which is
        // what the service this replaces did. Turn it off to require every member to
        // be written into the household file first.
        autoEnrolIdentities: bool('AUTO_ENROL_IDENTITIES', true),
        allowDevIdentity,
        devIdentities: text('DEV_IDENTITIES', '')
            .split(',')
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),

        // Crossbar device identity
        requireDeviceAuth,
        // The operator's way in to the console. A hash, never a password: this file is
        // read by anything that can read the service's configuration. Set it with
        // `node src/admin.js password`, which is the only thing that writes it.
        adminPasswordHash: text('CROSSBAR_ADMIN_PASSWORD_HASH', ''),
        // Where the settings and the mode are written back to. The file this process read,
        // not whatever the working directory happens to be by the time a request arrives.
        envFile: ENV_FILE,
        sessionSecret,
        sessionTtlSeconds: integer('CROSSBAR_SESSION_TTL_SECONDS', 43200, 60, 2592000),
        challengeTtlSeconds: integer('CROSSBAR_CHALLENGE_TTL_SECONDS', 120, 30, 900),
        enrollmentTtlSeconds: integer('CROSSBAR_ENROLLMENT_TTL_SECONDS', 900, 60, 86400),

        // Call behaviour
        callRingSeconds: integer('CALL_RING_SECONDS', 90, 30, 300),
        maxParticipants: integer('MAX_PARTICIPANTS', 4, 2, 8),
        // Ringing your own other devices. Off by default: a call with only you in
        // it is not a call, and a household that never needs it should not be able
        // to create one by accident.
        allowSelfCalls: bool('ALLOW_SELF_CALLS', false),

        // Signalling
        signalPath: text('SIGNAL_PATH', '/socket.io/'),
        messageBytes: integer('MAX_MESSAGE_BYTES', 131072, 4096, 1048576),
        sdpBytes: integer('MAX_SDP_BYTES', 65536, 4096, 262144),
        iceBytes: integer('MAX_ICE_BYTES', 4096, 256, 65536),
        pingIntervalMs: integer('PING_INTERVAL_MS', 25000, 1000, 120000),
        pingTimeoutMs: integer('PING_TIMEOUT_MS', 20000, 1000, 120000),
        relayPerSecond: integer('RELAY_PER_SECOND', 60, 1, 1000),
        statusPerSecond: integer('STATUS_PER_SECOND', 10, 1, 1000),
        malformedLimit: integer('MALFORMED_LIMIT', 10, 1, 1000),

        // Media
        iceServers: Object.freeze([
            ...(stunUrl ? [{ urls: stunUrl }] : []),
            ...(turnUrl && turnUsername && turnCredential
                ? [{ urls: turnUrl, username: turnUsername, credential: turnCredential }]
                : []),
        ]),
        // STUN and TURN for a deployment that relays. `iceServers` above is a static
        // list, which is all a tailnet household ever needs; when a TURN host is
        // configured the per-device list from `ice.js` is used instead, because a
        // credential that ships inside a client is a credential everybody has.
        turn: Object.freeze({
            host: turnHost,
            port: turnPort,
            minPort: turnMinPort,
            maxPort: turnMaxPort,
            sharedSecret: turnSharedSecret,
            ttlSeconds: integer('CROSSBAR_TURN_TTL_SECONDS', 600, 60, 86400),
        }),

        // Push (optional; absent keys mean the capability reports itself disabled)
        vapidPublicKey: text('VAPID_PUBLIC_KEY', ''),
        vapidPrivateKey: text('VAPID_PRIVATE_KEY', ''),
        vapidSubject: text('VAPID_SUBJECT', ''),

        // APNs, for ringing a phone that is asleep. The key is the `.p8` from the developer
        // account, named by file rather than pasted into an environment: it is a secret with
        // newlines in it, and a deployment already has somewhere to keep one.
        apnsKeyId: text('CROSSBAR_APNS_KEY_ID', ''),
        apnsTeamId: text('CROSSBAR_APNS_TEAM_ID', ''),
        apnsKeyPath: text('CROSSBAR_APNS_KEY_PATH', ''),
        apnsKey: text('CROSSBAR_APNS_KEY', ''),
        // The app's bundle id. The topic a call is pushed on is this with `.voip` on the
        // end, which is the only topic a PushKit registry may be sent.
        apnsTopic: text('CROSSBAR_APNS_TOPIC', ''),

        nodeEnv: text('NODE_ENV', 'development'),
    });
}

// ── Choosing between the two configurations ─────────────────────────────────
//
// `.env` holds both: a block per mode naming where that mode is reached, and a
// section generated from the one selected. Switching rewrites the generated section
// and nothing else, so the secrets, paths, limits and relay settings in between are
// never touched by it. Both blocks are ordinary `.env` lines, and `modeValue` above
// reads whichever one is selected.

const MODE_BEGIN = '# >>> the configuration in force, written by `node src/admin.js mode` >>>';
const MODE_END = '# <<< end of the configuration in force <<<';

const MODES = Object.freeze(['private', 'public']);
const MODE_NAMES = Object.freeze(['HOSTNAME', 'ORIGIN', 'BIND_ADDRESS']);

/** The names the generated section owns, in the order it writes them. */
const GENERATED_KEYS = Object.freeze([
    'CROSSBAR_NETWORK_MODE', 'CROSSBAR_PUBLIC_HOSTNAME', 'PUBLIC_ORIGIN',
    'CROSSBAR_BIND_ADDRESS', 'TRUST_TAILSCALE_HEADERS', 'CROSSBAR_REQUIRE_DEVICE_AUTH',
]);

/** A mode's own block, as `{ HOSTNAME, ORIGIN, BIND_ADDRESS }` — empty strings unset. */
function modeBlock(content, mode) {
    const values = {};
    for (const name of MODE_NAMES) {
        const key = `NETWORK_MODE_${mode.toUpperCase()}_${name}=`;
        const line = content.split('\n').find((item) => item.trim().startsWith(key));
        values[name] = line ? line.trim().slice(key.length).trim() : '';
    }
    return values;
}

/**
 * The `.env` a switch produces: the selected mode's own values written under the names
 * everything downstream reads — the server, Caddy, the units — and the overrides that
 * would contradict the mode emptied, so the mode's own defaults decide. Everything
 * outside the generated section, comments included, is left exactly as it was.
 *
 * Pure, so the same content and mode always give the same answer, and it can be tested
 * without a file.
 */
function applyMode(content, mode) {
    if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
    const values = modeBlock(content, mode);
    const generated = [
        MODE_BEGIN,
        `CROSSBAR_NETWORK_MODE=${mode}`,
        `CROSSBAR_PUBLIC_HOSTNAME=${values.HOSTNAME}`,
        `PUBLIC_ORIGIN=${values.ORIGIN}`,
        `CROSSBAR_BIND_ADDRESS=${values.BIND_ADDRESS}`,
        '# Left empty on purpose: the mode decides both. The identity header is believed',
        '# only in private mode, and device keys are required only in public.',
        'TRUST_TAILSCALE_HEADERS=',
        'CROSSBAR_REQUIRE_DEVICE_AUTH=',
        MODE_END,
    ];
    const lines = content.split('\n');
    const begin = lines.findIndex((line) => line.trim() === MODE_BEGIN);
    const end = lines.findIndex((line) => line.trim() === MODE_END);
    // Whatever else in the file names one of these would be read first, and `loadDotEnv`
    // keeps the first value it sees: a line left over from an earlier hand-edit would
    // quietly beat the one being written here.
    const outside = [
        ...(begin === -1 ? lines : lines.slice(0, begin)),
        ...(end === -1 ? [] : lines.slice(end + 1)),
    ].filter((line) => !GENERATED_KEYS.some((key) => line.trim().startsWith(`${key}=`)));
    return [...outside, ...generated].join('\n');
}

// ── Changing the configuration from somewhere that is not a shell ───────────────
//
// Two things write `.env`: the CLI and the console. Both go through here, so there is one
// implementation of "change one line, check what the file now makes of itself, and put it
// back if that does not hold up" rather than two that drift apart.

/**
 * What an operator may change, and what each one means.
 *
 * A whitelist, not the file: these are the settings whose worst case is a server that
 * behaves differently. The ones whose worst case is a server nobody can reach — the
 * listener, the origin, the signing secret, the addresses a mode is reached at — are not on
 * it, and neither is anything that is a secret.
 */
const KNOBS = Object.freeze([
    { key: 'MAX_PARTICIPANTS', label: 'People in a call', type: 'integer', min: 2, max: 8,
      help: 'The most anyone can be in a call with at once.' },
    { key: 'CALL_RING_SECONDS', label: 'Ringing time', type: 'integer', min: 10, max: 600, unit: 'seconds',
      help: 'How long a call rings before it gives up.' },
    { key: 'ALLOW_SELF_CALLS', label: 'Calls with yourself', type: 'boolean',
      help: 'Whether one person may ring their own other devices. Useful for testing, odd otherwise.' },
    { key: 'AUTO_ENROL_IDENTITIES', label: 'Enrol arrivals automatically', type: 'boolean',
      help: 'On, a login arriving from the tailnet joins the household by itself; off, only people already in the file are accepted.' },
    { key: 'CROSSBAR_ENROLLMENT_TTL_SECONDS', label: 'Invitation lifetime', type: 'integer', min: 60, max: 86400, unit: 'seconds',
      help: 'How long an enrolment code stays usable.' },
    { key: 'CROSSBAR_SESSION_TTL_SECONDS', label: 'Session lifetime', type: 'integer', min: 60, max: 2592000, unit: 'seconds',
      help: 'How long a device — or this console — stays signed in before proving itself again.' },
    { key: 'CROSSBAR_CHALLENGE_TTL_SECONDS', label: 'Challenge lifetime', type: 'integer', min: 30, max: 900, unit: 'seconds',
      help: 'How long a device has to answer a challenge. Shorter is safer and slower.' },
    { key: 'ICE_STUN_URL', label: 'STUN server', type: 'url',
      help: 'Where clients ask for their own address, which is how a direct connection is found.' },
    { key: 'CROSSBAR_TURN_HOST', label: 'Relay host', type: 'text',
      help: 'Empty means no relay. Set, media that cannot go direct is relayed through this host.' },
    { key: 'CROSSBAR_TURN_PORT', label: 'Relay port', type: 'integer', min: 1, max: 65535 },
    { key: 'CROSSBAR_TURN_MIN_PORT', label: 'Relay port range starts', type: 'integer', min: 1024, max: 65535 },
    { key: 'CROSSBAR_TURN_MAX_PORT', label: 'Relay port range ends', type: 'integer', min: 1024, max: 65535 },
    { key: 'CROSSBAR_TURN_TTL_SECONDS', label: 'Relay credential lifetime', type: 'integer', min: 60, max: 86400, unit: 'seconds' },
    { key: 'MAX_MESSAGE_BYTES', label: 'Largest signal', type: 'integer', min: 4096, max: 1048576, unit: 'bytes',
      help: 'The most one signalling message may be. Offers and answers are the large ones.' },
    { key: 'PING_INTERVAL_MS', label: 'Keepalive interval', type: 'integer', min: 1000, max: 120000, unit: 'ms' },
    { key: 'PING_TIMEOUT_MS', label: 'Connection timeout', type: 'integer', min: 1000, max: 120000, unit: 'ms',
      help: 'How long a silent client is given before it is considered gone.' },
    { key: 'RELAY_PER_SECOND', label: 'Messages a second', type: 'integer', min: 1, max: 1000,
      help: 'The most one client may signal per second before it is throttled.' },
    { key: 'MALFORMED_LIMIT', label: 'Malformed messages tolerated', type: 'integer', min: 1, max: 1000,
      help: 'How many bad messages a client may send before it is disconnected.' },
]);

const knobFor = (key) => KNOBS.find((knob) => knob.key === String(key).toUpperCase()) || null;

/** One value, as the file should hold it, or a refusal that says what is wrong. */
function validateKnob(knob, value) {
    if (knob.type === 'boolean') return /^(1|true|yes)$/i.test(String(value)) ? 'true' : 'false';
    if (knob.type === 'integer') {
        const number = Number.parseInt(String(value), 10);
        if (!Number.isFinite(number)) throw new Error(`${knob.label} has to be a whole number.`);
        if (number < knob.min || number > knob.max) {
            throw new Error(`${knob.label} has to be between ${knob.min} and ${knob.max}.`);
        }
        return String(number);
    }
    const text = String(value ?? '').trim();
    if (knob.type === 'url' && text && !/^(stun|turn|turns):\S+$/i.test(text)) {
        throw new Error(`${knob.label} has to look like stun:host:port.`);
    }
    return text;
}

/** One key set to one value, in place, with every other line left exactly as it was. */
function setEnvLine(content, key, value) {
    const lines = content.split('\n');
    const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (index === -1) return [...lines, line].join('\n');
    return [...lines.slice(0, index), line, ...lines.slice(index + 1)].join('\n');
}

/** The `.env` those changes produce, with every value checked before anything is written. */
function applyKnobs(content, changes) {
    let next = String(content);
    for (const [key, value] of Object.entries(changes || {})) {
        const knob = knobFor(key);
        if (!knob) throw new Error(`${key} is not a setting this console may change.`);
        next = setEnvLine(next, knob.key, validateKnob(knob, value));
    }
    return next;
}

/**
 * What a `.env` makes of itself, read by a child process with nothing but that file in its
 * environment — which is the question a restart asks. Answers `{ ok, message }`.
 */
function verifyEnvFile(dir, mode = null) {
    const env = { PATH: process.env.PATH };
    if (mode) env.CROSSBAR_NETWORK_MODE = mode;
    const result = spawnSync(process.execPath, [
        '-e', `require(${JSON.stringify(path.join(__dirname, 'config.js'))}).loadConfig()`,
    ], { cwd: dir, env, encoding: 'utf8' });

    const stderr = String(result.stderr || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const failure = stderr.find((line) => /Error: /.test(line)) || stderr[stderr.length - 1] || '';
    return { ok: result.status === 0, message: failure.replace(/^\w*Error: /, '') };
}

module.exports = {
    loadConfig,
    loadDotEnv,
    bool,
    integer,
    text,
    applyMode,
    modeBlock,
    MODES,
    KNOBS,
    knobFor,
    validateKnob,
    setEnvLine,
    applyKnobs,
    verifyEnvFile,
};
