'use strict';

// Where clients should send media.
//
// A direct path is preferred and nothing here arranges it: ICE finds one on its own
// when the two ends can reach each other. This is the fallback list — how to relay
// when they cannot — and it is built per device with credentials that expire, because
// a TURN credential that ships inside a client is a credential everybody has.

const crypto = require('node:crypto');

/**
 * coturn's REST scheme: the username carries its own expiry, and the password is the
 * HMAC of that username under a secret only this server and coturn hold. Nothing has
 * to be provisioned per user, and a credential that leaks is worthless within minutes.
 */
function temporaryTurnCredential({ sharedSecret, ttlSeconds, name, now }) {
    const expiresAt = Math.floor(Date.parse(now) / 1000) + ttlSeconds;
    const username = `${expiresAt}:${String(name || 'device').slice(0, 64)}`;
    const credential = crypto.createHmac('sha1', sharedSecret).update(username).digest('base64');
    return { username, credential, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

function staticServers(config) {
    return config.iceServers.map((server) => (server.username
        ? { urls: server.urls, username: server.username, credential: server.credential }
        : { urls: server.urls }));
}

/**
 * The ICE configuration one device is given.
 *
 * `name` goes into the TURN username, so an operator reading coturn's log can tell
 * whose relay a session was without the server keeping a table of them.
 */
function iceConfigFor({ config, now, name = 'device' }) {
    const turn = config.turn || {};
    const relayed = Boolean(turn.host && turn.sharedSecret);
    const urls = [];

    if (relayed) {
        // coturn answers STUN on the same port it serves TURN on, so a household that
        // opens one port for relaying gets discovery on it as well.
        urls.push({ urls: `stun:${turn.host}:${turn.port}` });
    }
    for (const server of staticServers(config)) urls.push(server);

    if (relayed) {
        const { username, credential } = temporaryTurnCredential({
            sharedSecret: turn.sharedSecret,
            ttlSeconds: turn.ttlSeconds,
            name,
            now,
        });
        urls.push({
            urls: [
                `turn:${turn.host}:${turn.port}?transport=udp`,
                `turn:${turn.host}:${turn.port}?transport=tcp`,
            ],
            username,
            credential,
        });
    }

    return { iceServers: urls, ttl: relayed ? turn.ttlSeconds : 0 };
}

module.exports = { iceConfigFor, temporaryTurnCredential };
