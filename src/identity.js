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

const DEV_COOKIE = 'crossbar.dev.identity';

function normalizeLogin(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isLoopback(address) {
    if (!address) return false;
    if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true;
    return net.isIP(address) === 6 && address.endsWith('::1');
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

    if (config.trustTailscaleHeaders) {
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

module.exports = { resolveIdentity, isLoopback, normalizeLogin, DEV_COOKIE };
