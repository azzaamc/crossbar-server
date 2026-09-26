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
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const WebSocket = require('ws');

const directoryFile = require('./directory');
// The names this process reads live in `config.js`, beside the reads they describe. This is
// the one place that asks what a `.env` holds that they do not cover.
const { unreadEnvKeys, writtenMode } = require('./config');

const PROBE_TIMEOUT_MS = 4000;

async function check(name, run) {
    try {
        const result = await run();
        // A warning is a check that passed and still has something to say: it does not
        // change the exit code, and it is not a failure — an unknown name in `.env` means
        // a setting is not in force, not that the server is broken.
        return { name, ok: Boolean(result?.ok), detail: result?.detail || '', ...(result?.warn ? { warn: true } : {}) };
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
        socket.on('unexpected-response', (_request, response) => {
            // A refusal is an answer, and in public mode it is the expected one: the
            // socket requires a device session, so a probe that presents none is
            // *supposed* to be turned away. Being turned away proves the upgrade
            // reached the server, which is the whole question this check asks.
            // Anything else — a 404, a 502, a gateway that never forwards the upgrade
            // — means it did not, and that is what should be reported as a failure.
            const reachable = response.statusCode === 401 || response.statusCode === 403;
            finish({
                ok: reachable,
                detail: `HTTP ${response.statusCode}${reachable ? ', authentication required' : ''}`,
            });
        });
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

// ── A first install ─────────────────────────────────────────────────────────────
//
// The questions between "the software is here" and "the software is reachable", which are
// the ones a first install actually gets wrong: there is no directory file yet, the file
// names nobody who can administer it, the data directory belongs to root, the tree it is
// created in belongs to an account this host does not have, or the port is already held by
// the service that was supposed to have been stopped. Measured 2026-09-26: a first install
// with a root-owned `data/` reported "HTTPS: fetch failed" and nothing else — true, and
// useless to whoever has to fix it. So these are asked first, each with its own reason on
// its own line.

/** The directory file, read the way the server reads it, so the next start agrees with this. */
function checkDirectoryFile(config) {
    const directory = directoryFile.read(config.directoryConfigPath);
    const administrators = directory.users.filter((user) => user.admin && user.enabled !== false);
    return {
        ok: true,
        detail: `${directory.users.length} ${directory.users.length === 1 ? 'person' : 'people'}, `
            + `${administrators.length} administrator${administrators.length === 1 ? '' : 's'}`,
    };
}

/** The data directory: the database, the staged `.env` writes and the backups all land here. */
function checkDataDir(config) {
    const existed = fs.existsSync(config.dataDir);
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const probe = path.join(config.dataDir, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, '', { mode: 0o600 });
    fs.unlinkSync(probe);
    // A directory that had to be made is said out loud rather than passed over: this is
    // where the database and the backups are about to live, and an operator who typed
    // `DATA_DIR` has just been told where it resolved to.
    return { ok: true, detail: existed ? `${config.dataDir} is writable` : `${config.dataDir} did not exist; created it` };
}

/**
 * The name this host gives a uid, `null` when it gives none, `undefined` when the question cannot
 * be asked because `id` is not runnable here.
 *
 * Node has no lookup of its own: `os.userInfo` answers about the account that called it and
 * ignores the id it is handed. Measured on Node 22.23.0, 2026-09-26: `os.userInfo({ uid: 0 })`
 * and `os.userInfo({ uid: 12345 })` both reported the calling process's own account. `id -nu` is
 * what a person would type, and it resolves a numeric id through NSS, which is the same database
 * `systemd`'s `User=` starts the service out of.
 */
function uidName(uid) {
    const probe = spawnSync('id', ['-nu', String(uid)], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    if (probe.error) return undefined;
    return probe.status === 0 ? (String(probe.stdout).trim() || null) : null;
}

/**
 * The directory `data/` is created and kept in, and the account that owns it.
 *
 * `writeEnvFile` makes `data/` under this directory — it is the one place the service's sandbox
 * grants a write, `<repo>/data` beside `<repo>/.env` in `ReadWritePaths=` — so a parent the
 * service user cannot write is a deployment whose every `.env` write and whose database fail,
 * one `EACCES` at a time, in a process that names the file rather than the directory.
 *
 * A `tar` built on macOS carries its builder's uid and a root extract restores it, so an upgrade
 * can leave the tree owned by an account this host has never heard of. Measured on the live
 * deployment, 2026-09-26: an upgrade left `<repo>` owned by uid 501, and the service user could
 * not write the staged `.env` at all.
 *
 * Writability as the service user is deliberately not claimed, because this command runs as root
 * as often as it runs as the deployment's own account and root's `W_OK` succeeds whatever the
 * mode says — a check that asked that question would pass on exactly the broken box. What is
 * read is what can be read: the owner uid and whether this host has an account for it, the mode,
 * and the group. That is a failure when the write is provably somebody else's: an owner no
 * account claims, under a mode that leaves nothing to the group and nothing to anybody else.
 */
function checkDataParent(config, statOf = fs.statSync, accountOf = uidName) {
    const parent = path.dirname(config.dataDir);
    let stats;
    try {
        stats = statOf(parent);
    } catch (error) {
        return { ok: false, detail: `${parent} cannot be read (${error.code || String(error.message).slice(0, 80)}), and \`${path.basename(config.dataDir)}/\` is created there` };
    }
    const mode = (stats.mode & 0o7777).toString(8).padStart(4, '0');
    const owner = accountOf(stats.uid);
    // `id`'s numeric lookups are the user's: `id -ng 20` reads 20 as a *user* name and answers
    // nothing. So the group is the number the stat gave rather than a name guessed at through
    // the owner's own group, which a setgid directory need not share.
    const group = `gid ${stats.gid}`;
    const facts = `${parent} is owned by ${owner || `uid ${stats.uid}`} (mode ${mode}, group ${group})`;
    if (owner === undefined) {
        return { ok: true, detail: `${facts}, and whether this host has an account for that uid cannot be asked here: the id command is not runnable` };
    }
    if (owner === null && (stats.mode & 0o022) === 0) {
        return { ok: false, detail: `${parent} is owned by uid ${stats.uid}, which this host has no account for (mode ${mode}, group ${group}): with the write left neither to the group nor to anybody else, nothing but root may write there. Read the owner, the mode and the group, not a writability test, which as root passes whatever the mode says.` };
    }
    return { ok: true, detail: `${facts} — read rather than tested for writability, which as root passes whatever the mode says` };
}

/** Whether the thing answering on this deployment's port is a Crossbar server. */
async function answersAsCrossbar(config) {
    const host = config.host.includes(':') ? `[${config.host}]` : config.host;
    try {
        const response = await fetch(`http://${host}:${config.port}/api/health`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const body = await response.json().catch(() => ({}));
        return response.ok && body.status === 'ok';
    } catch {
        return false;
    }
}

/**
 * Whether the port this deployment binds is free, or already held by a Crossbar server.
 *
 * Being held by *us* is the healthy answer, not a fault: this command is run on a running
 * box at least as often as on a new one. Neither answer is available from the error a
 * start reports — "address already in use" names neither the holder nor the fact that the
 * holder is this very deployment — so the port is tried here and, if it is taken, the
 * thing holding it is asked whether it is one of ours.
 */
function checkListener(config) {
    return new Promise((resolve) => {
        const server = net.createServer();
        const finish = (result) => {
            try { server.close(); } catch { /* never listened */ }
            resolve(result);
        };
        server.on('error', async (error) => {
            if (error.code !== 'EADDRINUSE') return finish({ ok: false, detail: String(error.message).slice(0, 160) });
            const ours = await answersAsCrossbar(config);
            return finish(ours
                ? { ok: true, detail: `${config.host}:${config.port} is held by a Crossbar server` }
                : { ok: false, detail: `${config.host}:${config.port} is held by something that is not this deployment` });
        });
        server.on('listening', () => finish({ ok: true, detail: `${config.host}:${config.port} is free` }));
        server.listen(config.port, config.host);
    });
}

/**
 * Whether a host answers on the port it is reached at.
 *
 * Kept apart from resolution because they fail for different reasons and are fixed by
 * different people: a name that does not resolve is fixed at the registrar, and a silent
 * port in the firewall or in whatever is meant to be proxying. "Not reachable" tells an
 * operator neither.
 */
async function checkIngress(hostname, port) {
    if (!(await tcpReachable(hostname, port))) {
        return { ok: false, detail: `${hostname} resolves but nothing answers on ${port}` };
    }
    return { ok: true, detail: `${hostname} resolves and ${port} answers` };
}

/** Public mode's own requirement: the name resolves, and the address it is reached at answers. */
async function checkPublicIngress(config) {
    const resolved = await checkDns(config.publicHostname);
    if (!resolved.ok) return resolved;
    // The port comes from the origin rather than being assumed to be 443: a deployment
    // reached at `https://host:8443` is reached there, and looking at 443 would call its
    // front door shut. The origin is already known to be https in public mode.
    const port = Number(new URL(config.publicOrigin).port) || 443;
    return checkIngress(config.publicHostname, port);
}

/** The first non-empty line of a command's output, for a report that is one line per check. */
const firstLine = (text) => String(text || '').split('\n').map((line) => line.trim()).filter(Boolean)[0]?.slice(0, 120) || '';

/**
 * Private mode's own requirement: Tailscale is on this machine and is serving the loopback
 * port this deployment listens on.
 *
 * Both halves are the fault an operator cannot see from anywhere else. Without Tailscale
 * a tailnet deployment has no front door at all. With Tailscale serving a *different*
 * port it has one that points at nothing, which presents as a page that loads and every
 * call failing — a shape that reads as the app's own problem. The port is looked for
 * rather than the hostname because the port is what `Tailscale Serve` resolves out of
 * `.env`, and a line like `|-- / proxy http://127.0.0.1:3003` is what proves it.
 */
function checkTailscale(config, command = 'tailscale') {
    const version = spawnSync(command, ['version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    if (version.error) {
        return { ok: false, detail: 'the tailscale command is not runnable here, and this mode is reached through it' };
    }
    if (!config.port) {
        return { ok: false, detail: 'PORT is 0, so there is no loopback port for Tailscale to serve' };
    }
    const served = spawnSync(command, ['serve', 'status'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    const output = `${served.stdout || ''}${served.stderr || ''}`.trim();
    if (served.error || served.status !== 0) {
        return { ok: false, detail: `tailscale serve is not serving anything (${firstLine(output) || `exit ${served.status}`})` };
    }
    if (!new RegExp(`(^|[^0-9])${config.port}([^0-9]|$)`).test(output)) {
        return { ok: false, detail: `Tailscale is not serving port ${config.port} (${firstLine(output) || 'nothing is served'})` };
    }
    return { ok: true, detail: `serving the loopback listener (port ${config.port})` };
}

/**
 * The configuration file, as something other than this process reads it: the names in it, and
 * whether it says which mode it is in.
 *
 * A warning rather than a failure, and the only check here that is: the server is running and
 * neither of these changes what it does — which is exactly what makes them worth saying. A
 * typo'd `CROSSBAR_SESSION_SECERT` is a setting the operator believes is in force. A file with
 * no `CROSSBAR_NETWORK_MODE` line is a *fresh install*, and there the mode is in force by
 * default while both front doors' units grep for that line before they configure anything: on
 * a new private deployment nothing ever runs `tailscale serve`, so the server is healthy on
 * loopback and unreachable from the tailnet. Measured on the rehearsal host, 2026-09-26.
 */
function checkEnvFile(config) {
    if (!config.envFile || !fs.existsSync(config.envFile)) {
        return { ok: true, warn: true, detail: 'no .env beside this process, so there is nothing to misread' };
    }
    const content = fs.readFileSync(config.envFile, 'utf8');
    const said = [];

    const unread = unreadEnvKeys(content);
    if (unread.length) {
        const named = unread.map(({ key, suggestion }) => (suggestion
            ? `${key}, did you mean ${suggestion}?`
            : `${key}, and nothing close to it is read`));
        said.push(`${unread.length} name${unread.length === 1 ? '' : 's'} nothing reads: ${named.join('; ')}.`);
    }

    if (!writtenMode(content)) {
        said.push('The file does not say which mode it is in: the mode is in force by default, and both front'
            + ' doors read a CROSSBAR_NETWORK_MODE line before they configure anything — nothing else notices'
            + ` the difference. \`node src/admin.js mode ${config.networkMode}\` writes the section it is missing.`);
    }

    if (!said.length) {
        return {
            ok: true,
            detail: `every name in ${path.basename(config.envFile)} is one this server reads,`
                + ' and the file says which mode it is in',
        };
    }
    return { ok: true, warn: true, detail: said.join(' ') };
}

/**
 * Every line of a `.env` that sets a name, as `{ key, value, line }` — the shape `loadDotEnv`
 * accepts, with the line number kept, which is what an operator needs to fix a duplicate and
 * what `config.js`'s name-only reader throws away.
 */
function envSettings(content) {
    const settings = [];
    String(content ?? '').split(/\r?\n/).forEach((rawLine, index) => {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) return;
        const equals = line.indexOf('=');
        if (equals < 1) return;
        let value = line.slice(equals + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        settings.push({ key: line.slice(0, equals).trim(), value, line: index + 1 });
    });
    return settings;
}

/** The lines a name is set on, as an operator reads them: "lines 12 and 40". */
function lineNumbers(lines) {
    return `lines ${lines.length === 2
        ? lines.join(' and ')
        : `${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`}`;
}

/**
 * A name the file sets more than once, where only the first line is in force.
 *
 * `loadDotEnv` reads top-down and keeps what it already has, so a line appended below an existing
 * one looks set and is not: the setting the operator just wrote is the one that does nothing.
 * Measured on the live deployment, 2026-09-26: an appended `NETWORK_MODE_PUBLIC_BIND_ADDRESS=`
 * was ignored because an earlier block had won, and the certificate that line was meant to make
 * possible never appeared anywhere.
 *
 * A warning rather than a failure, like the names nothing reads beside it: the server is running,
 * and what is wrong is that the file says something that is not so.
 */
function checkDuplicateSettings(config) {
    if (!config.envFile || !fs.existsSync(config.envFile)) {
        return { ok: true, detail: 'no .env beside this process, so there is nothing to misread' };
    }
    const byName = new Map();
    for (const setting of envSettings(fs.readFileSync(config.envFile, 'utf8'))) {
        byName.set(setting.key, [...(byName.get(setting.key) || []), setting.line]);
    }
    const repeated = [...byName].filter(([, lines]) => lines.length > 1);
    if (!repeated.length) {
        return { ok: true, detail: `every name in ${path.basename(config.envFile)} is set once` };
    }
    const named = repeated.map(([key, lines]) => `${key}, on ${lineNumbers(lines)}`);
    return {
        ok: true,
        warn: true,
        detail: `${repeated.length} name${repeated.length === 1 ? '' : 's'} set more than once: ${named.join('; ')}.`
            + ' Only the first of each is in force — the loader reads top-down and keeps what it already has —'
            + ' so everything set on a later line does nothing.',
    };
}

/**
 * Public mode's bind address, which must name the address this deployment is reached at.
 *
 * `0.0.0.0`, `::` and empty all mean *every* address, and tailscaled already holds `0.0.0.0:443`
 * in public mode, so Caddy cannot take the port and never obtains a certificate: what the operator
 * sees is a TLS failure about a name that is perfectly configured, far from the setting at fault.
 * Measured on the live deployment, 2026-09-26. The mode's generated section writes this name and
 * the Caddyfile expands it, so the value read here is the address Caddy binds — the first one,
 * because that is the one `loadDotEnv` keeps.
 */
function checkPublicBindAddress(config) {
    if (!config.envFile || !fs.existsSync(config.envFile)) {
        return { ok: true, detail: 'no .env beside this process, so there is no bind address to read' };
    }
    const setting = envSettings(fs.readFileSync(config.envFile, 'utf8'))
        .find((line) => line.key === 'NETWORK_MODE_PUBLIC_BIND_ADDRESS');
    if (setting && setting.value && !['0.0.0.0', '::', '[::]'].includes(setting.value)) {
        return { ok: true, detail: `NETWORK_MODE_PUBLIC_BIND_ADDRESS is ${setting.value}, which names one address` };
    }
    const held = setting
        ? `NETWORK_MODE_PUBLIC_BIND_ADDRESS is ${setting.value ? `\`${setting.value}\`` : 'empty'}`
        : 'NETWORK_MODE_PUBLIC_BIND_ADDRESS is not set, so nothing names an address at all';
    return {
        ok: false,
        detail: `${held}, which Caddy binds as every address: tailscaled already holds 0.0.0.0:443 in public mode,`
            + ' so Caddy never obtains a certificate. It must name the address this deployment is reached at.',
    };
}

// ── The report ──────────────────────────────────────────────────────────────────

/**
 * Every check this deployment can meaningfully run right now.
 *
 * A private deployment skips the public checks rather than failing them: a tailnet
 * directory is not broken for lacking a hostname, and reporting it as one teaches an
 * operator to ignore the output.
 *
 * `store` is the open database, and `storeError` is why there is none when there is none —
 * which is the ordinary state of a first install, and a check in its own right rather than
 * a reason not to report the rest.
 */
async function diagnose({ config, store = null, storeError = null }) {
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

    // A first install fails here, before any question about the network is worth asking.
    results.push(await check('Directory file', () => checkDirectoryFile(config)));
    results.push(await check('Data directory', () => checkDataDir(config)));
    results.push(await check('Data directory parent', () => checkDataParent(config)));
    results.push(await check('Listener', () => checkListener(config)));
    results.push(isPublic
        ? await check('Public ingress', () => checkPublicIngress(config))
        : await check('Tailscale', () => checkTailscale(config)));
    results.push(await check('Configuration file', () => checkEnvFile(config)));
    results.push(await check('Duplicate settings', () => checkDuplicateSettings(config)));

    if (store) {
        results.push(await check('Database', async () => {
            const users = store.listUsers();
            const devices = store.allDevices();
            return { ok: true, detail: `${users.length} people, ${devices.length} devices` };
        }));
    } else if (storeError) {
        // Said rather than thrown: on a first install there is no database to open yet, and
        // that is one thing wrong among several rather than the end of the report.
        results.push({ name: 'Database', ok: false, detail: storeError });
    }

    if (isPublic) {
        // The setting that decides whether any of the four below can work: a bind address that
        // takes in tailscaled's 443 is a certificate that never arrives, which reads as TLS.
        results.push(await check('Public bind address', () => checkPublicBindAddress(config)));
        results.push(await check('DNS', () => checkDns(config.publicHostname)));
        results.push(await check('TLS certificate', () => checkCertificate(config.publicHostname)));
        results.push(await check('HTTPS', () => checkHttps(config.publicOrigin)));
        results.push(await check('WebSocket', () => checkWebSocket(config.publicOrigin, config.signalPath)));
    } else {
    // Not `config.publicOrigin`: in private mode that is the tailnet name, and this box is the
    // thing serving it, so asking itself over the tailnet fails on a deployment that is perfectly
    // reachable — a diagnostic lying in the one place it must not. The question worth asking here
    // is whether the server answers on the loopback listener that Serve publishes, which is both
    // answerable from inside and exactly what a caller on the tailnet is asking.
    results.push(await check('Server answering', () => checkHttps(`http://127.0.0.1:${config.port}`)));
    }

    const stun = config.iceServers.find((server) => String(server.urls).startsWith('stun:'));
    results.push(await check('STUN', () => checkStun(stun?.urls)));
    results.push(await check('TURN', () => checkTurn(config)));

    return results;
}

/**
 * What the per-check lines come to: failures and warnings, counted apart.
 *
 * Here rather than in the printer because this is the rule the doctor's exit code is made
 * of — a warning is not a failure — and a rule that lives only inside a `switch` is a rule
 * nothing can hold to account.
 */
function summariseResults(results) {
    return {
        failed: results.filter((result) => !result.ok && !result.warn).length,
        warned: results.filter((result) => result.warn).length,
        checked: results.length,
    };
}

module.exports = {
    diagnose,
    stunQuery,
    mappedAddress,
    parseStunUrl,
    summariseResults,
    // Exported for the tests that have to make each first-install check fail for its own
    // reason; nothing in the server calls these directly except `diagnose`.
    checkDirectoryFile,
    checkDataDir,
    checkDataParent,
    checkListener,
    checkIngress,
    checkPublicIngress,
    checkTailscale,
    checkEnvFile,
    checkDuplicateSettings,
    checkPublicBindAddress,
};
