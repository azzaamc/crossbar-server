'use strict';

// Configuration for the Crossbar server. Every process.env read lives here, so the
// set of things that can change behaviour is one file long.

const fs = require('node:fs');
const path = require('node:path');

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

loadDotEnv(path.resolve(process.cwd(), '.env'));

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

    const publicOrigin = httpsOrigin(text('PUBLIC_ORIGIN', `http://${host}:${integer('PORT', 3010, 1, 65535)}`), 'PUBLIC_ORIGIN');
    const allowDevIdentity = bool('ALLOW_DEV_IDENTITY', false);
    if (allowDevIdentity && !LOOPBACK.has(host)) {
        throw new Error('ALLOW_DEV_IDENTITY requires a loopback listener');
    }

    const stunUrl = text('ICE_STUN_URL', 'stun:stun.l.google.com:19302');
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

        // Identity
        trustTailscaleHeaders: bool('TRUST_TAILSCALE_HEADERS', true),
        // A login that arrives from the tailnet is enrolled on first sight, which is
        // what the service this replaces did. Turn it off to require every member to
        // be written into the household file first.
        autoEnrolIdentities: bool('AUTO_ENROL_IDENTITIES', true),
        allowDevIdentity,
        devIdentities: text('DEV_IDENTITIES', '')
            .split(',')
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),

        // Call behaviour
        callRingSeconds: integer('CALL_RING_SECONDS', 90, 30, 300),
        maxParticipants: integer('MAX_PARTICIPANTS', 4, 2, 8),

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

        // Push (optional; absent keys mean the capability reports itself disabled)
        vapidPublicKey: text('VAPID_PUBLIC_KEY', ''),
        vapidPrivateKey: text('VAPID_PRIVATE_KEY', ''),
        vapidSubject: text('VAPID_SUBJECT', ''),

        nodeEnv: text('NODE_ENV', 'development'),
    });
}

module.exports = { loadConfig, loadDotEnv, bool, integer, text };
