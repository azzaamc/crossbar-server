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

// ── What a `.env` may name ──────────────────────────────────────────────────────
//
// `loadDotEnv` keeps every line it is given — it has no way to tell a setting from a
// typo — and reads are by name, so a name nothing reads does nothing at all, in
// silence. Measured 2026-09-26: `CROSSBAR_SESSION_SECERT` in a `.env` left the server
// with no session secret and no complaint anywhere. `doctor` warns about the names
// below that a file is missing, which is the only place that mistake can be caught.
//
// The list is what this file reads *and* what the rest of the deployment is handed:
// the mode's generated section writes `CROSSBAR_BIND_ADDRESS` for the Caddyfile and the
// units to expand, and the relay unit renders `CROSSBAR_TURN_EXTERNAL_IP` into coturn.
// Those are read by the deployment rather than by this process, and leaving them out
// would make a perfectly correct file warn — which is how an operator learns to ignore
// the warning. `test/visibility.test.js` holds the documented file (`.env.example`) and
// the names this process reads side by side, so the two cannot drift apart unnoticed.
const ENV_KEYS = Object.freeze([
    // Listener, and the files this server reads and writes
    'HOST', 'PORT', 'DATA_DIR', 'DIRECTORY_CONFIG_PATH', 'WEB_ROOT',
    // The mode in force, and both configurations it moves between
    'CROSSBAR_NETWORK_MODE', 'CROSSBAR_PUBLIC_HOSTNAME', 'PUBLIC_ORIGIN', 'CROSSBAR_BIND_ADDRESS',
    'NETWORK_MODE_PRIVATE_HOSTNAME', 'NETWORK_MODE_PRIVATE_ORIGIN', 'NETWORK_MODE_PRIVATE_BIND_ADDRESS',
    'NETWORK_MODE_PUBLIC_HOSTNAME', 'NETWORK_MODE_PUBLIC_ORIGIN', 'NETWORK_MODE_PUBLIC_BIND_ADDRESS',
    // What may be believed about a request, and how a device proves itself
    'TRUST_TAILSCALE_HEADERS', 'ALLOW_DEV_IDENTITY', 'DEV_IDENTITIES', 'AUTO_ENROL_IDENTITIES',
    'CROSSBAR_REQUIRE_DEVICE_AUTH', 'CROSSBAR_SESSION_SECRET', 'CROSSBAR_ADMIN_PASSWORD_HASH',
    'CROSSBAR_SESSION_TTL_SECONDS', 'CROSSBAR_CHALLENGE_TTL_SECONDS', 'CROSSBAR_ENROLLMENT_TTL_SECONDS',
    // Calls
    'CALL_RING_SECONDS', 'MAX_PARTICIPANTS', 'ALLOW_SELF_CALLS',
    // Signalling
    'SIGNAL_PATH', 'MAX_MESSAGE_BYTES', 'MAX_SDP_BYTES', 'MAX_ICE_BYTES',
    'PING_INTERVAL_MS', 'PING_TIMEOUT_MS', 'RELAY_PER_SECOND', 'STATUS_PER_SECOND', 'MALFORMED_LIMIT',
    // Media: the public STUN server, a static TURN server, and the one this deployment runs
    'ICE_STUN_URL', 'ICE_TURN_URL', 'ICE_TURN_USERNAME', 'ICE_TURN_CREDENTIAL',
    'CROSSBAR_TURN_HOST', 'CROSSBAR_TURN_PORT', 'CROSSBAR_TURN_MIN_PORT', 'CROSSBAR_TURN_MAX_PORT',
    'CROSSBAR_TURN_SHARED_SECRET', 'CROSSBAR_TURN_TTL_SECONDS', 'CROSSBAR_TURN_EXTERNAL_IP',
    // Push
    'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT',
    'CROSSBAR_APNS_KEY_ID', 'CROSSBAR_APNS_TEAM_ID', 'CROSSBAR_APNS_KEY_PATH',
    'CROSSBAR_APNS_KEY', 'CROSSBAR_APNS_TOPIC',
    // The one name that is not this project's, but decides how it behaves
    'NODE_ENV',
]);

/** The names a `.env` holds, in the order it holds them. Comments and blanks hold none. */
function envNames(content) {
    const names = [];
    for (const rawLine of String(content ?? '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        // The same shape `loadDotEnv` accepts: `NAME=value`, with something before the `=`.
        const equals = line.indexOf('=');
        if (equals < 1) continue;
        names.push(line.slice(0, equals).trim());
    }
    return names;
}

/** How many single-character edits apart two names are, abandoned once past `cap`. */
function editDistance(a, b, cap) {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let row = 1; row <= a.length; row += 1) {
        const current = [row];
        for (let column = 1; column <= b.length; column += 1) {
            current[column] = Math.min(
                previous[column] + 1,
                current[column - 1] + 1,
                previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
            );
        }
        if (Math.min(...current) > cap) return cap + 1;
        previous = current;
    }
    return previous[b.length];
}

/** The name on the list closest to this one, if any is close enough to be worth naming. */
function nearestEnvKey(name) {
    // Three edits for a long name, two for a short one: `CROSSBAR_SESSION_SECERT` is two
    // from `CROSSBAR_SESSION_SECRET`, and a name that is not close to anything gets no
    // suggestion rather than a wrong one — a wrong one costs an operator more than it saves.
    const allowed = Math.max(2, Math.round(name.length / 6));
    let best = null;
    let bestDistance = allowed + 1;
    for (const key of ENV_KEYS) {
        const distance = editDistance(name, key, bestDistance);
        if (distance < bestDistance) {
            best = key;
            bestDistance = distance;
        }
    }
    return best;
}

/**
 * The names a `.env` holds that nothing reads, each with the name probably meant.
 *
 * Only the names this project owns are reported: the ones beginning `CROSSBAR_` or
 * `NETWORK_MODE_`, and `DATA_DIR`. `HOST`, `PORT`, `NODE_ENV` and their like are shared
 * with other tools, and a name typed beside them that is not ours is not evidence of a
 * mistake here. Nothing in this project writes a setting it does not read, so a name of
 * ours that is not on the list is a typo by definition.
 */
function unreadEnvKeys(content) {
    const owned = (name) => /^(CROSSBAR_|NETWORK_MODE_)/.test(name) || name === 'DATA_DIR';
    const unread = [];
    for (const name of new Set(envNames(content))) {
        if (ENV_KEYS.includes(name) || !owned(name)) continue;
        unread.push({ key: name, suggestion: nearestEnvKey(name) });
    }
    return unread;
}

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
    // not a deployment (a laptop, a test). `modeKey` is declared with the mode vocabulary
    // below, beside the names a mode's own block holds.
    const modeValue = (name, fallback = '') => text(modeKey(networkMode, name), text(name, fallback));

    const publicOrigin = httpsOrigin(
        modeValue('ORIGIN', `http://${host}:${integer('PORT', 3003, 1, 65535)}`),
        `PUBLIC_ORIGIN or ${modeKey(networkMode, 'ORIGIN')}`,
    );

    const publicHostname = modeValue('HOSTNAME').toLowerCase();
    if (networkMode === 'public') {
        if (!publicHostname) {
            throw new Error(`${modeKey(networkMode, 'HOSTNAME')} (or CROSSBAR_PUBLIC_HOSTNAME) is required in public mode: it is the host invitations send people to`);
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
        // The same number Caddy's `reverse_proxy 127.0.0.1:{$PORT:3003}` falls back to. Two
    // defaults for one port is a public deployment that proxies to nothing, silently.
    port: integer('PORT', 3003, 0, 65535),
        publicOrigin,

        // Files
        dataDir: path.resolve(text('DATA_DIR', './data')),
        directoryConfigPath: path.resolve(text('DIRECTORY_CONFIG_PATH', './data/directory.json')),
        webRoot: path.resolve(text('WEB_ROOT', './public')),

        // Transport and trust
        networkMode,
        publicHostname,
        trustTailscaleHeaders,

        // Identity
        // A login that arrives from the tailnet is enrolled on first sight, which is
        // what the service this replaces did. Turn it off to require every member to
        // be written into the directory file first.
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
        // it is not a call, and a directory that never needs it should not be able
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
        // list, which is all a tailnet directory ever needs; when a TURN host is
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

/** The name one of `MODE_NAMES` is written under in a mode's own block, in `.env`. */
const modeKey = (mode, name) => `NETWORK_MODE_${mode.toUpperCase()}_${name}`;

/** The names the generated section owns, in the order it writes them. */
const GENERATED_KEYS = Object.freeze([
    'CROSSBAR_NETWORK_MODE', 'CROSSBAR_PUBLIC_HOSTNAME', 'PUBLIC_ORIGIN',
    'CROSSBAR_BIND_ADDRESS', 'TRUST_TAILSCALE_HEADERS', 'CROSSBAR_REQUIRE_DEVICE_AUTH',
]);

/**
 * What each mode's own block has to name before that mode is a configuration rather than a
 * placeholder, as `MODE_NAMES` entries. This table is the whole of "this mode is configured":
 * every reader of that question goes through `modeConfigured` below.
 *
 * Derived from the reads in `loadConfig`, and bound to them by `test/mode-configured.test.js`,
 * which loads a file per mode with these names set and then the same file with each name
 * emptied in turn. A name belongs here exactly when its absence is what stops the server, so
 * this cannot drift into a second opinion about what a mode needs.
 *
 * `private` needs only its origin. Its hostname is not read in that mode at all — it exists so
 * that public mode can build the invitation origin — and an absent private origin is survivable
 * because `loadConfig` falls back to the loopback default. That default is the reason the name
 * is required all the same: an invitation carries the origin, and nobody can accept an
 * invitation to `http://127.0.0.1:3003`.
 *
 * `public` needs a hostname, and an origin that names it: an absent origin falls back to the
 * loopback one and is refused for naming the wrong host, and an empty line is refused outright.
 * `BIND_ADDRESS` is deliberately not here. Nothing in `loadConfig` reads it — it is the address
 * Caddy binds, put in the generated section for the proxy by `applyMode` — so an empty one
 * leaves a server that starts and a proxy that does not. That is `doctor`'s Public bind address
 * check, which reports it where an operator can act on it; a predicate that refused every mode
 * the proxy cannot serve would also refuse the runs that are not deployments.
 */
const MODE_REQUIRED = Object.freeze({
    private: Object.freeze(['ORIGIN']),
    public: Object.freeze(['HOSTNAME', 'ORIGIN']),
});

/** A mode's own block, as `{ HOSTNAME, ORIGIN, BIND_ADDRESS }` — empty strings unset. */
function modeBlock(content, mode) {
    const values = {};
    for (const name of MODE_NAMES) {
        const key = `${modeKey(mode, name)}=`;
        const line = content.split('\n').find((item) => item.trim().startsWith(key));
        values[name] = line ? line.trim().slice(key.length).trim() : '';
    }
    return values;
}

/**
 * Whether a mode is one this deployment can be shaped for: its own block names everything that
 * mode needs to start, or the names it does not. Answers `{ configured, missing }`, with
 * `missing` naming the file's own keys (`NETWORK_MODE_PUBLIC_HOSTNAME`), because that is what an
 * operator has to go and fill in.
 *
 * The question the two mode units ask before they move a front door, through
 * `node src/admin.js mode --configured`, and the question a setup wizard will ask before it
 * offers a mode. Deliberately not the same as which mode is in force — `writtenMode` answers
 * that, and a file can say one thing and hold nothing — so a caller that needs both asks both.
 *
 * The units used to ask `writtenMode` alone, as a whole-line `grep -qx
 * CROSSBAR_NETWORK_MODE=public`. Measured 2026-09-26, on a file saying `public` whose public
 * block was empty: that grep passed, so the public shaper started Caddy — which cannot render
 * the Caddyfile without `CROSSBAR_BIND_ADDRESS` — and scheduled `tailscale serve off` for the
 * end of the grace window, while the server crash-looped on the names that were missing.
 * Fifteen minutes later there was no front door in either direction, and the close that made it
 * so was on a timer: nothing outside the box can undo it. A mode that cannot start may not
 * close a door on a deployment's behalf, which is why this is a predicate and not a grep.
 *
 * `modeBlock` reads the block, so the answer is about the names a mode owns and not about the
 * plain-name overrides a run that is not a deployment may set: whether a mode can be switched
 * to is not the same question as whether this process starts. A file that is not there is not
 * configured, for either mode — every name is missing.
 */
function modeConfigured(mode, envPath = null) {
    if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
    const file = envPath === null ? ENV_FILE : path.resolve(envPath);
    const block = modeBlock(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', mode);
    const missing = MODE_REQUIRED[mode].filter((name) => !block[name]).map((name) => modeKey(mode, name));
    return { configured: missing.length === 0, missing };
}

/**
 * The mode the file itself says is in force, or null when it does not say.
 *
 * Deliberately not the same question as which mode the configuration resolves to:
 * `loadConfig` defaults to `private`, so a `.env` with no generated section — which is what
 * `deploy/.env.example` produces, because the section is written by the first switch — is in
 * force as private while saying nothing at all. Something outside this process reads the
 * line: both mode shapers ask for it before they configure anything
 * (`node src/admin.js mode --configured`, which is this *and* `modeConfigured` below), so a
 * fresh install whose file does not carry it configures no front door — the server is healthy
 * on loopback and nobody on the tailnet can reach it, which `status` and `/api/health` both
 * report as fine. A value that is merely the default still has to be written down, and this is
 * why.
 *
 * The first occurrence wins, because `loadDotEnv` keeps the first value it sees.
 */
function writtenMode(content) {
    for (const rawLine of String(content ?? '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith('CROSSBAR_NETWORK_MODE=')) continue;
        const value = line.slice('CROSSBAR_NETWORK_MODE='.length).trim().toLowerCase();
        return MODES.includes(value) ? value : null;
    }
    return null;
}

/**
 * The `.env` a switch produces: the selected mode's own values written under the names
 * everything downstream reads — the server, Caddy, the units — inside the generated section,
 * and the overrides that would contradict the mode emptied, so the mode's own defaults
 * decide. Everything outside that section, comments included, is left exactly as it was.
 *
 * A generated name *outside* the section is refused rather than deleted or left alone.
 * `loadDotEnv` keeps the first value it sees, so a hand-written `PUBLIC_ORIGIN=` above the
 * section would quietly beat the one being written here: the deployment would be reached at
 * an address its mode does not name. Deleting the line is what this is fixing — the plain
 * names are the supported override for a run that is not a deployment (`loadConfig` above
 * reads them) — and leaving it is worse than either, so the file has to be fixed by the
 * person who wrote it.
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
    // One marker without the other, or them the wrong way round, means nobody can say which
    // lines are the section's: half of them would be treated as the operator's and half as
    // replaceable, and a refusal that says so is the only answer that cannot lose a line.
    if ((begin === -1) !== (end === -1) || (begin !== -1 && end < begin)) {
        throw new Error('The generated section is damaged: this file has one of its two marker lines without the other, or has them the wrong way round. Fix that, then switch.');
    }
    const section = begin !== -1;
    // The message carries the line number on purpose: the operator has to find the one line to
    // remove, and a file that names a generated key in two places is exactly the file where
    // that is not obvious from the text alone.
    for (let index = 0; index < lines.length; index += 1) {
        if (section && index >= begin && index <= end) continue;
        const key = GENERATED_KEYS.find((name) => lines[index].trim().startsWith(`${name}=`));
        if (key) {
            throw new Error(`${key} is set outside the generated section, on line ${index + 1}.`
                + ' Remove that line: the mode writes this name itself, and a line left outside would'
                + ' override what the mode decides.');
        }
    }
    // Rewritten where it was, so the lines around it keep both their text and their order.
    if (section) return [...lines.slice(0, begin), ...generated, ...lines.slice(end + 1)].join('\n');
    // A hand-written `.env`, or one written before the first switch, has no section yet: it
    // goes at the end, leaving the operator's own settings where they put them.
    return [...lines, ...generated].join('\n');
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
      help: 'On, a login arriving from the tailnet joins the directory by itself; off, only people already in the file are accepted.' },
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

/**
 * Where a write keeps what it replaces, and why it lands on `.env` itself: the service's
 * sandbox grants write to the data directory and to `.env`, and to nothing else — least of all
 * the code directory `.env` sits in.
 *
 * A rename is atomic — a reader sees the whole old file or the whole new one — and it is what
 * this writer used to do, staging `<dataDir>/.env.writing` and `renameSync`ing it onto `.env`,
 * on the reasoning that a rename works across directories and so needs no new allowance. That
 * reasoning is wrong about *which* directory it needs. A rename needs write permission on the
 * directory the name lands in, and the directory holding `.env` is the code directory the unit
 * deliberately cannot write: `ProtectSystem=strict` with `ReadWritePaths=<repo>/data
 * <repo>/.env` is enough for a write to that file and not for a rename onto it. Measured on
 * the live deployment, 2026-09-26: the console's mode switch and its settings changes failed
 * `EACCES`, whole and correct from the CLI, which runs in an unsandboxed shell — so the
 * console could not move the box and the tool the console wraps could. The write therefore
 * goes through the one permission the sandbox does grant, onto the file itself.
 *
 * In place is not atomic, and that is the price, stated plainly: a crash between the truncate
 * and the last byte leaves a partial `.env`, where a rename would have left one of the two
 * whole files. The recovery path is `<dataDir>/env.previous`, written before the new content
 * and readable by whoever has the machine; and a file truncated past its generated section no
 * longer says which mode it is in, which is the doctor's mode check (`src/diagnostics.js`,
 * `writtenMode`). Trading atomicity for reachability is what makes the console able to reshape
 * a hardened box at all.
 *
 * Nothing of the file's identity changes, and in place is what guarantees it: the same inode
 * keeps its owner and its mode. The rename did not — it gave `.env` the *staging* file's
 * identity. Measured on Debian, 2026-09-26: `sudo node src/admin.js mode private`, the thing
 * every runbook reaches for when the service user cannot write its own tree, left `.env` owned
 * by root, mode 600, correct in every way the operator could see, and the service (`User=admin`)
 * could not start: `errno: -13, code: 'EACCES', path: '/home/admin/crossbar/.env'` — a symptom
 * that appears at the next start, in a different process, naming a file that looks fine. The
 * old writer repaired that from the file being replaced; there is now nothing to repair. A
 * symlinked `.env` is written through rather than replaced for the same reason.
 *
 * Errors are the caller's: a write that cannot complete has to be reported, because the caller
 * is the only thing that knows whether a change still holds without it.
 */
function writeEnvFile(envPath, content) {
    // The expression `loadConfig` resolves `config.dataDir` from, deliberately not
    // `loadConfig().dataDir` — this must still work while putting back a file whose contents
    // do not load, which is the one moment it matters.
    const dataDir = path.resolve(text('DATA_DIR', './data'));
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const previous = path.join(dataDir, 'env.previous');
    const held = fs.existsSync(envPath) ? fs.statSync(envPath) : null;
    // 0o600 is the floor rather than the target. A file that was already private keeps exactly
    // the mode its operator gave it — `chmod 400 .env` is a decision, and changing a setting is
    // not a reason to undo it — and anything readable by a group or by everybody is written
    // back private, because this file holds the session secret and the console's hash.
    const mode = held && (held.mode & 0o077) === 0 && (held.mode & 0o400) !== 0 ? held.mode & 0o777 : 0o600;
    let lent = false;
    if (held) {
        // Before the new content, because this copy is the file a person reads to put the old
        // configuration back — and because copying before writing means a copy that fails
        // leaves `.env` exactly as it was.
        fs.copyFileSync(envPath, previous);
        // `copyFileSync` gives the copy whatever permissions the original had, and `.env` holds
        // the session secret and the console's hash: the kept copy is as sensitive as the file
        // it came from, so it is pinned rather than inherited.
        fs.chmodSync(previous, 0o600);
        // Writing in place needs the file itself to be writable, which making a new file and
        // moving it over did not: measured on macOS, 2026-09-26, opening a `chmod 400 .env` for
        // writing as its owner is `EACCES`. `chmod 400 .env` is a decision this file's contents
        // justify, and it is kept: the owner-write bit is lent for the duration of one write and
        // the mode below puts the file back. A crash inside that window leaves it at 0600 rather
        // than 0400, which is the only other thing the loss of atomicity costs.
        if ((held.mode & 0o200) === 0) {
            fs.chmodSync(envPath, (held.mode & 0o777) | 0o200);
            lent = true;
        }
    }
    try {
        fs.writeFileSync(envPath, content, { mode });
    } catch (error) {
        // The lent bit does not outlive the call even when the call fails: whatever state the
        // write left the file in, it is not left more open than its operator made it. The
        // error is thrown on, because the caller is the only thing that knows whether the
        // change it asked for still holds.
        if (lent) fs.chmodSync(envPath, mode);
        throw error;
    }
    // `mode` on a write applies to a file being created, and a file created through it is
    // masked by the umask; this is the mode the deployment will be read under, and it is what
    // puts back a 0400 file lent the write bit above.
    fs.chmodSync(envPath, mode);
}

module.exports = {
    loadConfig,
    loadDotEnv,
    ENV_KEYS,
    unreadEnvKeys,
    bool,
    integer,
    text,
    writeEnvFile,
    applyMode,
    modeBlock,
    modeConfigured,
    MODE_REQUIRED,
    MODE_NAMES,
    writtenMode,
    MODES,
    KNOBS,
    knobFor,
    validateKnob,
    setEnvLine,
    applyKnobs,
    verifyEnvFile,
};
