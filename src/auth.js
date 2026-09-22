'use strict';

// Crossbar's own authentication: a key per device, enrolled once, used to answer a
// challenge.
//
// This is the canonical application identity in both network modes. The tailnet is
// how a private deployment is *reached* — and the identity header a local proxy
// injects is real evidence about the device that arrived — but neither is the thing
// that decides who somebody is. Reachability and identity are separate questions, and
// a server on the open internet can only answer the second one cryptographically.
//
// Nothing here is invented cryptography: P-256 ECDSA signatures, SHA-256, HMAC-SHA256
// and CSPRNG bytes, all from `node:crypto`.

const crypto = require('node:crypto');

/** Prefix on every session token, so a token from another scheme cannot be parsed as one of these. */
const TOKEN_VERSION = 'v1';

/** The cookie the operator's console session lives in. HttpOnly: no script can read it. */
const OPERATOR_COOKIE = 'crossbar_admin';

/** The only signing algorithm accepted. Curve and hash are fixed with it — see `deviceKeyFrom`. */
const ALGORITHM = 'ES256';
const CURVE = 'prime256v1';

/**
 * The exact bytes a device signs.
 *
 * It is a fixed string rather than JSON because both ends have to agree byte for byte,
 * and JSON has more than one way to spell the same object. Changing this line breaks
 * every enrolled device, so it carries a version of its own.
 */
const SIGNED_PREFIX = 'crossbar-device-auth-v1';

const NONCE_BYTES = 32;
const ENROLLMENT_BYTES = 32;
const MAX_SIGNATURE_BYTES = 512;
const MAX_PUBLIC_KEY_CHARS = 2048;

function randomId(bytes = 16) {
    return crypto.randomBytes(bytes).toString('base64url');
}

/** Device ids the server makes. The prefix keeps them apart from ids a client chose for itself. */
function newDeviceId() {
    return `dev_${randomId(12)}`;
}

/** 256 bits of entropy, url-safe so it survives a QR code and a copy-paste. */
function newEnrollmentToken() {
    return crypto.randomBytes(ENROLLMENT_BYTES).toString('base64url');
}

/** Invitations are stored only as this, so a copy of the database is not a stack of working codes. */
function hashToken(token) {
    return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function constantTimeEquals(a, b) {
    const left = Buffer.from(String(a), 'utf8');
    const right = Buffer.from(String(b), 'utf8');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function signedPayload({ deviceId, challengeId, nonce }) {
    return Buffer.from(`${SIGNED_PREFIX}\n${deviceId}\n${challengeId}\n${nonce}`, 'utf8');
}

/**
 * A device's public key, or null if it is not one we will accept.
 *
 * The key arrives as SPKI DER, which is what CryptoKit exports, and the curve is
 * checked rather than assumed: the algorithm field a client sends is a claim, and the
 * key itself is the fact.
 */
function deviceKeyFrom(publicKeyBase64, algorithm) {
    if (String(algorithm || '').toUpperCase() !== ALGORITHM) return null;
    const encoded = String(publicKeyBase64 || '').trim();
    if (!encoded || encoded.length > MAX_PUBLIC_KEY_CHARS) return null;
    let key;
    try {
        key = crypto.createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
    } catch {
        return null;
    }
    if (key.asymmetricKeyType !== 'ec') return null;
    if (key.asymmetricKeyDetails?.namedCurve !== CURVE) return null;
    return key;
}

/** Whether `signature` is this device's signature over `payload`. */
function verifyDeviceSignature(device, payload, signatureBase64) {
    const key = deviceKeyFrom(device.publicKey, device.keyAlgorithm || ALGORITHM);
    if (!key) return false;
    let signature;
    try {
        signature = Buffer.from(String(signatureBase64 || '').trim(), 'base64');
    } catch {
        return false;
    }
    if (!signature.length || signature.length > MAX_SIGNATURE_BYTES) return false;
    try {
        // DER-encoded ECDSA over SHA-256 is Node's default here and CryptoKit's output.
        return crypto.verify('sha256', payload, key, signature);
    } catch {
        return false;
    }
}

// ── Sessions ────────────────────────────────────────────────────────────────────

/**
 * A short-lived proof that a device answered a challenge.
 *
 * It is signed rather than stored, so the server keeps no session table to grow or to
 * leak, and revocation is decided where it belongs: the device row is looked up on
 * every use, and a revoked device's token stops working even though it is still
 * correctly signed.
 */
function issueSession({ deviceId, userId, secret, ttlSeconds, now }) {
    const issuedAt = Math.floor(Date.parse(now) / 1000);
    const expiresAt = issuedAt + ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ d: deviceId, u: userId, iat: issuedAt, exp: expiresAt }), 'utf8')
        .toString('base64url');
    const body = `${TOKEN_VERSION}.${payload}`;
    const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return { token: `${body}.${signature}`, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

/** The claims a signed token carries, once its signature and its expiry hold up. */
function verifyToken(token, secret, now) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
    const body = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (!constantTimeEquals(parts[2], expected)) return null;
    let claims;
    try {
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!claims || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.parse(now)) return null;
    return claims;
}

/** A device session's claims, or null: the shape a device session has and no other does. */
function verifySession(token, secret, now) {
    const claims = verifyToken(token, secret, now);
    if (!claims || typeof claims.d !== 'string' || typeof claims.u !== 'string') return null;
    return claims;
}

/**
 * The session a request carries, if any.
 *
 * Four places, because four kinds of client exist: a header for anything that can set
 * one, a second header name for clients that want to keep `Authorization` for something
 * else, the query string because a browser cannot set headers on a WebSocket upgrade,
 * and the operator's cookie — which the page's own script is not allowed to read, so it
 * cannot leak it either.
 */
function tokenFromRequest(req) {
    const authorization = req.headers?.authorization;
    if (typeof authorization === 'string' && /^bearer /i.test(authorization)) {
        return authorization.slice(7).trim();
    }
    const named = req.headers?.['x-crossbar-session'];
    if (typeof named === 'string' && named.trim()) return named.trim();
    const cookie = cookieFromRequest(req, OPERATOR_COOKIE);
    if (cookie) return cookie;
    try {
        const url = new URL(req.url || '/', 'http://localhost');
        const query = url.searchParams.get('token');
        if (query) return query.trim();
    } catch {
        // A URL that cannot be parsed carries no token.
    }
    return null;
}

/** One cookie, by name, out of whatever the request sent. */
function cookieFromRequest(req, name) {
    const header = req.headers?.cookie;
    if (typeof header !== 'string') return null;
    for (const part of header.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return rest.join('=').trim() || null;
    }
    return null;
}

/**
 * The device and person a request proves itself to be, or null.
 *
 * Null is not a failure here: it means "no device session", and the caller decides
 * what else it is willing to accept. That is what lets a private deployment keep
 * working with the devices it already has while public mode demands a key.
 */
function sessionFromRequest(req, { store, config, now }) {
    if (!config.sessionSecret) return null;
    const claims = verifySession(tokenFromRequest(req), config.sessionSecret, now);
    if (!claims) return null;
    const device = store.deviceIdentity(claims.d);
    if (!device || device.status !== 'active' || device.userId !== claims.u) return null;
    const user = store.userById(claims.u);
    if (!user) return null;
    return { device, user, claims };
}

// ── The operator ────────────────────────────────────────────────────────────────

/**
 * A password hash, in one line, with the parameters that made it.
 *
 * scrypt, because it is the one Node ships that is meant for passwords: memory-hard, so
 * guessing is expensive and checking is cheap. The cost travels with the hash, so raising
 * it later does not invalidate what is already set.
 */
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 32 });

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(String(password), salt, SCRYPT.keyLength, SCRYPT);
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
        salt.toString('base64'), key.toString('base64')].join(':');
}

/** Whether this password is the one that hash was made from. */
function verifyPassword(password, stored) {
    const parts = String(stored || '').split(':');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, salt, expected] = parts;
    let key;
    try {
        key = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'),
            Buffer.from(expected, 'base64').length,
            { N: Number(N), r: Number(r), p: Number(p) });
    } catch {
        return false;
    }
    return constantTimeEquals(key.toString('base64'), expected);
}

/**
 * The operator's way in to the console.
 *
 * The console is an operator surface, not a client, and asking whoever runs this household
 * to enrol a device key before they could open it made the console the hardest page in the
 * product to reach. So it has a password of its own — one, shared by whoever administers
 * the household, stored only as a hash.
 *
 * Deliberately not an account: no username, no recovery, nothing to enumerate, and the same
 * answer whether the password is wrong or none has been set. What it produces is a session
 * like any other, signed with the same secret.
 */
function openOperatorSession({ config, now, password }) {
    if (!config.sessionSecret || !config.adminPasswordHash) return { ok: false, reason: 'OPERATOR_DISABLED' };
    if (!verifyPassword(password, config.adminPasswordHash)) return { ok: false, reason: 'PASSWORD_INVALID' };
    return {
        ok: true,
        session: issueOperatorSession({
            secret: config.sessionSecret,
            ttlSeconds: config.sessionTtlSeconds,
            now,
        }),
    };
}

function issueOperatorSession({ secret, ttlSeconds, now }) {
    const issuedAt = Math.floor(Date.parse(now) / 1000);
    const expiresAt = issuedAt + ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ a: true, iat: issuedAt, exp: expiresAt }), 'utf8')
        .toString('base64url');
    const body = `${TOKEN_VERSION}.${payload}`;
    const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return { token: `${body}.${signature}`, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

/** An operator session's claims, or null: `a`, which no device session carries. */
function verifyOperatorToken(token, secret, now) {
    const claims = verifyToken(token, secret, now);
    if (!claims || claims.a !== true) return null;
    return claims;
}

/** The operator a request proves itself to be, or null. */
function operatorFromRequest(req, { config, now }) {
    if (!config.sessionSecret || !config.adminPasswordHash) return null;
    const claims = verifyOperatorToken(tokenFromRequest(req), config.sessionSecret, now);
    return claims ? { source: 'password', claims } : null;
}

// ── Enrolment ───────────────────────────────────────────────────────────────────

/**
 * A one-time invitation for one person's device.
 *
 * An invitation always names the person it is for. An unbound one would let whoever
 * held the code choose whose identity to take, which is the thing enrolment exists to
 * prevent — the operator knows which phone this is going on.
 */
function createInvitation({ store, config, now, userId, createdBy = null, ttlSeconds = null }) {
    if (!config.sessionSecret) return { ok: false, reason: 'DEVICE_AUTH_DISABLED' };
    const user = store.userById(userId);
    if (!user) return { ok: false, reason: 'USER_UNKNOWN' };

    const token = newEnrollmentToken();
    const seconds = ttlSeconds || config.enrollmentTtlSeconds;
    const enrollment = store.transaction(() => store.createEnrollment({
        id: `enr_${randomId(12)}`,
        tokenHash: hashToken(token),
        now,
        expiresAt: new Date(Date.parse(now) + seconds * 1000).toISOString(),
        createdBy,
        intendedUserId: user.id,
    }));

    return {
        ok: true,
        enrollment,
        // Returned exactly once, and never written down anywhere.
        token,
        payload: { version: 1, server: config.publicOrigin, enrollment_token: token },
    };
}

/**
 * Redeems an invitation for a device key.
 *
 * The spend and the registration are one transaction: an invitation must not be
 * consumed by a request that then fails, and two devices redeeming the same code must
 * not both end up registered.
 */
function enroll({ store, config, now, token, publicKey, algorithm, deviceName, platform, transportIdentity = null }) {
    if (!config.sessionSecret) return { ok: false, reason: 'DEVICE_AUTH_DISABLED' };

    const presented = String(token || '').trim();
    if (!presented || presented.length > 200) return { ok: false, reason: 'ENROLLMENT_INVALID' };

    // The key is checked before the invitation is looked at, so a malformed request
    // cannot be used to probe whether a token exists.
    if (!deviceKeyFrom(publicKey, algorithm)) return { ok: false, reason: 'DEVICE_KEY_INVALID' };

    const enrollment = store.enrollmentByHash(hashToken(presented));
    if (!enrollment) return { ok: false, reason: 'ENROLLMENT_INVALID' };
    if (enrollment.revokedAt) return { ok: false, reason: 'ENROLLMENT_REVOKED' };
    if (enrollment.usedAt) return { ok: false, reason: 'ENROLLMENT_USED' };
    if (enrollment.expiresAt <= now) return { ok: false, reason: 'ENROLLMENT_EXPIRED' };

    // `userById` already refuses a disabled person: it selects `enabled = 1`, and does
    // not return the flag, so there is nothing to check here but existence.
    const user = store.userById(enrollment.intendedUserId);
    if (!user) return { ok: false, reason: 'ENROLLMENT_INVALID' };

    const deviceId = newDeviceId();
    const device = store.transaction(() => {
        if (!store.useEnrollment(enrollment.id, deviceId, now)) return null;
        const registered = store.registerEnrolledDevice({
            id: deviceId,
            userId: user.id,
            label: deviceName,
            platform,
            publicKey: String(publicKey).trim(),
            algorithm: ALGORITHM,
            now,
        });
        // Enrolling a device is someone arriving, and on a public server it is the only
        // arrival there is: the network identity header that used to mark a person present
        // is refused there. Without this the household looks empty, which is how a
        // deployment with two phones in it came to show no contacts at all.
        if (registered) store.markSeen(user.id, now);
        return registered;
    });
    if (!device) return { ok: false, reason: 'ENROLLMENT_USED' };

    // Where the device arrived from, if that is something we know. It is recorded as
    // an authenticator rather than as part of the device, so it can be withdrawn
    // without touching the key and so no single mechanism becomes the identity.
    if (transportIdentity?.login) {
        store.rememberAuthenticator({
            id: `auth_${randomId(12)}`,
            deviceId: device.id,
            type: 'tailscale',
            externalSubject: transportIdentity.login,
            metadata: { name: transportIdentity.name || '', at: 'enrolment' },
            now,
        });
    }

    return {
        ok: true,
        device,
        user,
        session: issueSession({
            deviceId: device.id,
            userId: user.id,
            secret: config.sessionSecret,
            ttlSeconds: config.sessionTtlSeconds,
            now,
        }),
    };
}

// ── Challenge and response ──────────────────────────────────────────────────────

function challenge({ store, config, now, deviceId }) {
    if (!config.sessionSecret) return { ok: false, reason: 'DEVICE_AUTH_DISABLED' };
    const device = store.deviceIdentity(String(deviceId || ''));
    if (!device || !device.publicKey) return { ok: false, reason: 'DEVICE_UNKNOWN' };
    if (device.status !== 'active') return { ok: false, reason: 'DEVICE_REVOKED' };

    const challengeId = `chl_${randomId(16)}`;
    const nonce = crypto.randomBytes(NONCE_BYTES).toString('base64url');
    const expiresAt = new Date(Date.parse(now) + config.challengeTtlSeconds * 1000).toISOString();
    store.createChallenge({ id: challengeId, deviceId: device.id, nonce, now, expiresAt });

    return { ok: true, challengeId, nonce, expiresAt };
}

/**
 * The answer to a challenge, and the session it earns.
 *
 * The challenge is spent first, before the signature is even looked at, so a wrong
 * signature costs the attempt rather than leaving the challenge standing for the next
 * guess. Expiry is checked after the spend for the same reason.
 */
function completeSession({ store, config, now, deviceId, challengeId, signature }) {
    if (!config.sessionSecret) return { ok: false, reason: 'DEVICE_AUTH_DISABLED' };
    const device = store.deviceIdentity(String(deviceId || ''));
    if (!device || !device.publicKey) return { ok: false, reason: 'DEVICE_UNKNOWN' };
    if (device.status !== 'active') return { ok: false, reason: 'DEVICE_REVOKED' };

    const spent = store.consumeChallenge(String(challengeId || ''), now);
    if (!spent || spent.device_id !== device.id) return { ok: false, reason: 'CHALLENGE_INVALID' };
    if (spent.expires_at <= now) return { ok: false, reason: 'CHALLENGE_EXPIRED' };

    const signed = signedPayload({ deviceId: device.id, challengeId: spent.id, nonce: spent.nonce });
    if (!verifyDeviceSignature(device, signed, signature)) {
        return { ok: false, reason: 'SIGNATURE_INVALID' };
    }

    // A device whose person has been removed or disabled stops working here, because
    // `userById` will not return them.
    const user = store.userById(device.userId);
    if (!user) return { ok: false, reason: 'DEVICE_REVOKED' };

    store.touchDevice(device.id, now);
    return {
        ok: true,
        device,
        user,
        session: issueSession({
            deviceId: device.id,
            userId: user.id,
            secret: config.sessionSecret,
            ttlSeconds: config.sessionTtlSeconds,
            now,
        }),
    };
}

module.exports = {
    ALGORITHM,
    SIGNED_PREFIX,
    createInvitation,
    enroll,
    challenge,
    completeSession,
    sessionFromRequest,
    tokenFromRequest,
    openOperatorSession,
    operatorFromRequest,
    hashPassword,
    verifyPassword,
    OPERATOR_COOKIE,
    issueSession,
    verifySession,
    verifyDeviceSignature,
    deviceKeyFrom,
    signedPayload,
    hashToken,
    newEnrollmentToken,
    newDeviceId,
    randomId,
};
