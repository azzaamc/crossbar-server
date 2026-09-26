'use strict';

// Who is asking.
//
// Identity is a header the local Tailscale proxy injects, and it is accepted only
// when the connection actually came from loopback — the listener refuses to bind
// anywhere else, so "loopback" and "through the proxy" are the same statement.
//
// The same rule governs HTTP requests and WebSocket upgrades: an upgrade is an HTTP
// request, so a signalling socket is authenticated by exactly the mechanism the API
// uses. That is what lets admission be an authorization decision rather than a
// shared room name.

const net = require('node:net');
const crypto = require('node:crypto');

const DEV_COOKIE = 'crossbar.dev.identity';

// The credential the operator's own CLI presents, and the message it is derived over.
const OPERATOR_HEADER = 'x-crossbar-operator';
const OPERATOR_MESSAGE = 'crossbar-operator';

function normalizeLogin(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isLoopback(address) {
    if (!address) return false;
    if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true;
    return net.isIP(address) === 6 && address.endsWith('::1');
}

/**
 * The operator credential, derived from the session secret rather than stored.
 *
 * A deployment already has exactly one secret it must keep and cannot lose, and the box's
 * own tooling has to be able to say it is the box's own tooling in public mode too — where
 * a login is not a credential and a device key is demanded of every client. Deriving the
 * token means there is nothing new to generate, copy, back up or leak in a file, and it
 * revokes on the rotation that already signs every device out: change
 * `CROSSBAR_SESSION_SECRET` and yesterday's token stops matching, with no second thing to
 * remember. Read from the loaded configuration, which is where the server reads the secret
 * too, so a deployment that sets it in `.env` and one that passes it in the environment
 * derive the same token.
 */
function operatorToken(config) {
    const secret = config?.sessionSecret;
    if (!secret) return '';
    return crypto.createHmac('sha256', secret).update(OPERATOR_MESSAGE).digest('hex');
}

/**
 * Whether this request is the operator's own tooling, on the machine.
 *
 * Both halves are required, and neither alone is enough. The connection must have arrived
 * from loopback — the same fact that makes the proxy header a statement rather than a claim
 * in private mode — and the presented value must be the derived token, compared in constant
 * time so that guessing costs the same per byte whether or not the prefix is right.
 *
 * A deployment with no secret derives no token, and an empty expected value would make the
 * comparison pass on an absent header, so that case is refused before any comparison rather
 * than left to `timingSafeEqual`.
 */
function isOperatorRequest(req, config) {
    if (!isLoopback(req.socket?.remoteAddress)) return false;
    const expected = operatorToken(config);
    if (!expected) return false;
    const presented = req.headers[OPERATOR_HEADER];
    if (typeof presented !== 'string') return false;
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function cookieValue(header, name) {
    if (typeof header !== 'string') return '';
    for (const part of header.split(';')) {
        const equals = part.indexOf('=');
        if (equals < 0) continue;
        if (part.slice(0, equals).trim() !== name) continue;
        try {
            return decodeURIComponent(part.slice(equals + 1).trim());
        } catch {
            return '';
        }
    }
    return '';
}

/**
 * Resolves the caller, or null.
 *
 * `development` exists so the server can be exercised on a laptop where no Tailscale
 * proxy is present. It is refused unless the listener is loopback *and* the operator
 * turned it on explicitly, and a login is only accepted if it already names a
 * person already in the directory.
 */
function resolveIdentity(req, config) {
    if (!isLoopback(req.socket?.remoteAddress)) return null;

    // Public mode turns `trustTailscaleHeaders` off because a header there is typed by
    // whoever is calling. This request is not from a caller: it came from loopback carrying
    // a token only this machine can derive, which is the same pair of facts that make the
    // proxy header worth believing in private mode. Without it the operator's CLI stops the
    // moment the deployment goes public — the moment it is most needed.
    if (config.trustTailscaleHeaders || isOperatorRequest(req, config)) {
        const login = normalizeLogin(req.headers['tailscale-user-login']);
        if (login) {
            return {
                login,
                name: String(req.headers['tailscale-user-name'] || '').slice(0, 120),
                profilePic: String(req.headers['tailscale-user-profile-pic'] || '').slice(0, 500),
                source: 'tailscale',
            };
        }
    }

    if (config.allowDevIdentity) {
        const fromHeader = normalizeLogin(req.headers['x-dev-identity']);
        const fromCookie = normalizeLogin(cookieValue(req.headers.cookie, DEV_COOKIE));
        const login = fromHeader || fromCookie;
        if (login && (config.devIdentities.length === 0 || config.devIdentities.includes(login))) {
            // No name is supplied, so the display name comes from the login — which
            // is what a laptop has to work with, and keeps the configured directory
            // names in the directory file authoritative.
            return { login, name: '', profilePic: '', source: 'development' };
        }
    }

    return null;
}

module.exports = {
    resolveIdentity, isLoopback, normalizeLogin, operatorToken, isOperatorRequest,
    OPERATOR_HEADER, DEV_COOKIE,
};
