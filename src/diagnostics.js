'use strict';

// Is this deployment reachable in the way it claims to be?
//
// The checks are the ones that actually fail in the field, in the order they fail: a
// name that does not resolve, a certificate that does not match it, a port the
// internet cannot reach, a relay that does not answer. Each is reported on its own
// line rather than folded into one verdict, because "public mode is broken" is not
// something an operator can act on.
//
// Nothing here is a general-purpose protocol client. Each probe sends the smallest
// frame that can produce an answer and reads only that answer.

const dns = require('node:dns').promises;
const net = require('node:net');
const tls = require('node:tls');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const PROBE_TIMEOUT_MS = 4000;

async function check(name, run) {
    try {
        const result = await run();
        return { name, ok: Boolean(result?.ok), detail: result?.detail || '' };
    } catch (error) {
        return { name, ok: false, detail: String(error && error.message).slice(0, 160) };
    }
}

// ── DNS ─────────────────────────────────────────────────────────────────────────

async function checkDns(hostname) {
    const settled = await Promise.allSettled([
        dns.resolve4(hostname),
        dns.resolve6(hostname),
    ]);
    const v4 = settled[0].status === 'fulfilled' ? settled[0].value : [];
    const v6 = settled[1].status === 'fulfilled' ? settled[1].value : [];
    if (!v4.length && !v6.length) {
        return { ok: false, detail: `${hostname} does not resolve` };
    }
    return { ok: true, detail: `${hostname} -> ${[...v4, ...v6].join(', ')}` };
}

// ── TLS and HTTPS ───────────────────────────────────────────────────────────────

function checkCertificate(hostname, port = 443) {
    return new Promise((resolve) => {
        const socket = tls.connect({ host: hostname, port, servername: hostname, timeout: PROBE_TIMEOUT_MS }, () => {
            const certificate = socket.getPeerCertificate();
            socket.end();
            if (!certificate || !certificate.valid_to) {
                return resolve({ ok: false, detail: 'no certificate presented' });
            }
            const validTo = new Date(certificate.valid_to);
            const days = Math.round((validTo - Date.now()) / 86400000);
            const authorized = socket.authorized;
            const name = certificate.subject?.CN || hostname;
            resolve({
                ok: Boolean(authorized) && days > 0,
                detail: `${name}, expires in ${days} days${authorized ? '' : ' (not trusted)'}`,
            });
        });
        socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, detail: 'timed out' }); });
        socket.on('error', (error) => resolve({ ok: false, detail: String(error.message).slice(0, 160) }));
    });
}

async function checkHttps(origin) {
    const response = await fetch(new URL('/api/health', origin), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = await response.json().catch(() => ({}));
    return {
        ok: response.ok && body.status === 'ok',
        detail: `HTTP ${response.status}${body.mode ? `, mode ${body.mode}` : ''}`,
    };
}

/** The signalling socket, as a browser would open it: one handshake, then closed. */
function checkWebSocket(origin, signalPath) {
    return new Promise((resolve) => {
        const url = new URL(signalPath, origin);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('EIO', '4');
        url.searchParams.set('transport', 'websocket');
        const socket = new WebSocket(url, { handshakeTimeout: PROBE_TIMEOUT_MS });
        const finish = (result) => { try { socket.terminate(); } catch { /* already gone */ } resolve(result); };
        socket.on('message', (data) => {
            // Engine.IO opens with a packet starting '0'; anything else is not the
            // server we think we are talking to.
            const text = String(data);
            finish({ ok: text.startsWith('0'), detail: text.startsWith('0') ? 'engine open' : `unexpected frame ${text.slice(0, 40)}` });
        });
        socket.on('error', (error) => finish({ ok: false, detail: String(error.message).slice(0, 160) }));
        socket.on('unexpected-response', (_request, response) => finish({ ok: false, detail: `HTTP ${response.statusCode}` }));
    });
}

// ── STUN ────────────────────────────────────────────────────────────────────────

const MAGIC_COOKIE = 0x2112a442;

/** A binding request is 20 bytes and all of them are header. */
function bindingRequest(transactionId) {
    const header = Buffer.alloc(20);
    header.writeUInt16BE(0x0001, 0);
    header.writeUInt16BE(0, 2);
    header.writeUInt32BE(MAGIC_COOKIE, 4);
    transactionId.copy(header, 8);
    return header;
}

/** The mapped address out of a binding response, or null. */
function mappedAddress(packet) {
    if (packet.length < 20 || packet.readUInt16BE(0) !== 0x0101 || packet.readUInt32BE(4) !== MAGIC_COOKIE) {
        return null;
    }
    let offset = 20;
    const end = Math.min(packet.length, 20 + packet.readUInt16BE(2));
    while (offset + 4 <= end) {
        const type = packet.readUInt16BE(offset);
        const length = packet.readUInt16BE(offset + 2);
        const value = packet.subarray(offset + 4, offset + 4 + length);
        if ((type === 0x0020 || type === 0x0001) && value.length >= 8 && value[1] === 0x01) {
            const xor = type === 0x0020;
            const port = value.readUInt16BE(2) ^ (xor ? 0x2112 : 0);
            const address = [
                value[4] ^ (xor ? 0x21 : 0),
                value[5] ^ (xor ? 0x12 : 0),
                value[6] ^ (xor ? 0xa4 : 0),
                value[7] ^ (xor ? 0x42 : 0),
            ].join('.');
            return { address, port };
        }
        offset += 4 + length + ((4 - (length % 4)) % 4);
    }
    return null;
}

function stunQuery(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
    const transactionId = crypto.randomBytes(12);
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        const finish = (result) => { try { socket.close(); } catch { /* already closed */ } resolve(result); };
        const timer = setTimeout(() => finish(null), timeoutMs);
        socket.on('error', () => { clearTimeout(timer); finish(null); });
        socket.on('message', (message) => {
            // A transaction id is what makes this answer ours.
            if (!message.subarray(8, 20).equals(transactionId)) return;
            clearTimeout(timer);
            finish(mappedAddress(message));
        });
        socket.send(bindingRequest(transactionId), port, host, (error) => {
            if (error) { clearTimeout(timer); finish(null); }
        });
    });
}

function parseStunUrl(url) {
    const match = /^stun:([^:?]+)(?::(\d+))?$/i.exec(String(url || ''));
    if (!match) return null;
    return { host: match[1], port: Number(match[2] || 3478) };
}

/** What the internet thinks our address is, which is the question a home connection cannot answer locally. */
async function checkStun(url) {
    const target = parseStunUrl(url);
    if (!target) return { ok: false, detail: 'no STUN server configured' };
    const answer = await stunQuery(target.host, target.port);
    if (!answer) return { ok: false, detail: `${target.host}:${target.port} did not answer` };
    return { ok: true, detail: `public address ${answer.address}:${answer.port}` };
}

// ── TURN ────────────────────────────────────────────────────────────────────────

function tcpReachable(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port, timeout: timeoutMs });
        const finish = (ok) => { socket.destroy(); resolve(ok); };
        socket.on('connect', () => finish(true));
        socket.on('timeout', () => finish(false));
        socket.on('error', () => finish(false));
    });
}

/**
 * Whether a relay is answering, not whether it will relay for us.
 *
 * A real allocation needs credentials and a full TURN client; what an operator needs to
 * know first is whether the port is reachable at all, because an unreachable port makes
 * every later question moot. The distinction is stated rather than papered over.
 */
async function checkTurn(config) {
    const turn = config.turn || {};
    if (!turn.host) return { ok: true, detail: 'not configured (direct media only)' };
    const udp = await stunQuery(turn.host, turn.port);
    const tcp = await tcpReachable(turn.host, turn.port);
    const detail = `${turn.host}:${turn.port} udp ${udp ? 'answers' : 'silent'}, tcp ${tcp ? 'open' : 'closed'}`;
    return { ok: Boolean(udp) || tcp, detail: `${detail} (reachability only, not an allocation)` };
}

// ── The report ──────────────────────────────────────────────────────────────────

/**
 * Every check this deployment can meaningfully run right now.
 *
 * A private deployment skips the public checks rather than failing them: a tailnet
 * household is not broken for lacking a hostname, and reporting it as one teaches an
 * operator to ignore the output.
 */
async function diagnose({ config, store = null }) {
    const results = [];
    const isPublic = config.networkMode === 'public';

    results.push({
        name: 'Network mode',
        ok: true,
        detail: isPublic ? `public, ${config.publicHostname}` : 'private (tailnet)',
    });
    results.push({
        name: 'Device authentication',
        ok: Boolean(config.sessionSecret),
        detail: config.sessionSecret
            ? (config.requireDeviceAuth ? 'required' : 'available, not required')
            : 'not configured (CROSSBAR_SESSION_SECRET is empty)',
    });

    if (store) {
        results.push(await check('Database', async () => {
            const users = store.listUsers();
            const devices = store.allDevices();
            return { ok: true, detail: `${users.length} people, ${devices.length} devices` };
        }));
    }

    if (isPublic) {
        results.push(await check('DNS', () => checkDns(config.publicHostname)));
        results.push(await check('TLS certificate', () => checkCertificate(config.publicHostname)));
        results.push(await check('HTTPS', () => checkHttps(config.publicOrigin)));
        results.push(await check('WebSocket', () => checkWebSocket(config.publicOrigin, config.signalPath)));
    } else {
        results.push(await check('HTTPS', () => checkHttps(config.publicOrigin)));
    }

    const stun = config.iceServers.find((server) => String(server.urls).startsWith('stun:'));
    results.push(await check('STUN', () => checkStun(stun?.urls)));
    results.push(await check('TURN', () => checkTurn(config)));

    return results;
}

module.exports = { diagnose, stunQuery, mappedAddress, parseStunUrl };
