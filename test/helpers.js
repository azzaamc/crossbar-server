'use strict';

// Shared test scaffolding: a real server on an ephemeral port with a throwaway
// database, and a signalling client that speaks exactly the frames the native
// client sends — so the protocol tests exercise the contract rather than a
// convenient shape of it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { createCrossbarServer } = require('../src/server');
const { createLogger } = require('../src/log');

const DEV_USERS = ['abdullah@dev', 'dad@dev', 'mum@dev'];

const FAMILY = {
    users: [
        { id: 'abdullah', tailscaleLogin: 'abdullah@dev', displayName: 'Abdullah', relationship: 'Me', avatar: '', admin: true },
        { id: 'dad', tailscaleLogin: 'dad@dev', displayName: 'Dad', relationship: 'Father', avatar: '' },
        { id: 'mum', tailscaleLogin: 'mum@dev', displayName: 'Mum', relationship: 'Mother', avatar: '' },
    ],
    contacts: [
        { ownerId: 'abdullah', contactId: 'dad', sortOrder: 1 },
        { ownerId: 'abdullah', contactId: 'mum', sortOrder: 2 },
        { ownerId: 'dad', contactId: 'abdullah', sortOrder: 1 },
        { ownerId: 'dad', contactId: 'mum', sortOrder: 2 },
        { ownerId: 'mum', contactId: 'abdullah', sortOrder: 1 },
        { ownerId: 'mum', contactId: 'dad', sortOrder: 2 },
    ],
    groups: [{ id: 'family', displayName: 'Family', memberIds: ['abdullah', 'dad', 'mum'] }],
};

function silentLogger() {
    return createLogger({ level: 'error', stream: { write() {} } });
}

function baseConfig(dataDir, familyConfigPath, overrides = {}) {
    return {
        host: '127.0.0.1',
        port: 0,
        publicOrigin: 'http://127.0.0.1',
        dataDir,
        familyConfigPath,
        webRoot: path.join(__dirname, '..', 'public'),
        trustTailscaleHeaders: true,
        autoEnrolIdentities: true,
        allowDevIdentity: true,
        devIdentities: DEV_USERS,
        callRingSeconds: 90,
        maxParticipants: 4,
        allowSelfCalls: false,
        signalPath: '/socket.io/',
        messageBytes: 131072,
        sdpBytes: 65536,
        iceBytes: 4096,
        pingIntervalMs: 25000,
        pingTimeoutMs: 20000,
        relayPerSecond: 60,
        statusPerSecond: 10,
        malformedLimit: 10,
        iceServers: [{ urls: 'stun:example.invalid:3478' }],
        networkMode: 'private',
        publicHostname: '',
        requireDeviceAuth: false,
        sessionSecret: '',
        sessionTtlSeconds: 43200,
        challengeTtlSeconds: 120,
        enrollmentTtlSeconds: 900,
        turn: { host: '', port: 3478, minPort: 49160, maxPort: 49200, sharedSecret: '', ttlSeconds: 600 },
        vapidPublicKey: '',
        vapidPrivateKey: '',
        vapidSubject: '',
        nodeEnv: 'test',
        ...overrides,
    };
}

async function startTestServer(overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-test-'));
    const familyConfigPath = path.join(dir, 'family.json');
    fs.writeFileSync(familyConfigPath, JSON.stringify(FAMILY, null, 2));
    const config = baseConfig(dir, familyConfigPath, overrides);
    const server = createCrossbarServer({ config, log: silentLogger() });
    const address = await server.listen();
    return { server, dir, config, port: address.port, base: `http://127.0.0.1:${address.port}` };
}

/** One HTTP call as one person. */
async function api(base, who, route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${base}${route}`, {
        method,
        headers: {
            'content-type': 'application/json',
            ...(who ? { 'x-dev-identity': who } : {}),
            ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { raw: text };
    }
    return { status: response.status, data };
}

/**
 * A signalling client that mirrors the native client's framing exactly: wait for
 * the Engine.IO open packet, send `40`, take the `sid` from the Socket.IO connect,
 * then emit events as `42["name",{...}]` and read them back the same way.
 */
class TestPeer {
    constructor(ws) {
        this.ws = ws;
        this.raw = [];
        this.events = [];
        this.pings = 0;
        this.sid = '';
        this.closed = false;
        this.closeInfo = null;
    }

    static async connect(base, who, { deviceId = 'device-abcdefgh', expectConnect = true } = {}) {
        const url = `${base.replace('http', 'ws')}/socket.io/?EIO=4&transport=websocket&device=${encodeURIComponent(deviceId)}`;
        const ws = new WebSocket(url, who ? { headers: { 'x-dev-identity': who } } : {});
        const peer = new TestPeer(ws);
        ws.on('message', (data) => peer.handleFrame(data.toString()));
        ws.on('error', (error) => {
            peer.error = error;
        });
        ws.on('close', (code) => {
            peer.closed = true;
            peer.closeInfo = code;
        });

        await peer.waitFor((frame) => frame.startsWith('0'), 'engine open');
        peer.send('40');
        if (expectConnect) {
            const connectFrame = await peer.waitFor((frame) => frame.startsWith('40'), 'socket.io connect');
            try {
                peer.sid = JSON.parse(connectFrame.slice(2)).sid;
            } catch {
                peer.sid = '';
            }
        }
        return peer;
    }

    handleFrame(text) {
        for (const frame of text.split('\u001e')) {
            if (!frame) continue;
            this.raw.push(frame);
            if (frame.startsWith('42')) {
                try {
                    const parsed = JSON.parse(frame.slice(2));
                    this.events.push({ name: parsed[0], payload: parsed[1] });
                } catch {
                    /* a frame the client could not parse is not a frame it received */
                }
            } else if (frame === '2') {
                this.pings += 1;
            }
        }
    }

    send(frame) {
        this.ws.send(frame);
    }

    emit(name, payload) {
        this.send(`42${JSON.stringify([name, payload])}`);
    }

    async waitFor(predicate, label = 'frame', timeout = 4000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const found = this.raw.find(predicate);
            if (found !== undefined) return found;
            if (this.closed) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`timed out waiting for ${label}`);
    }

    received(name) {
        return this.events.filter((event) => event.name === name);
    }

    async waitForEvent(name, predicate = () => true, timeout = 4000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const found = this.received(name).find(predicate);
            if (found !== undefined) return found;
            if (this.closed) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`timed out waiting for ${name}`);
    }

    async waitForClose(timeout = 4000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline && !this.closed) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!this.closed) throw new Error('socket did not close');
    }

    async join({ channel, peerName = 'Someone', peerUuid = 'uuid-0000-0000-0000-000000000001' }) {
        this.emit('join', {
            join_data_time: new Date().toISOString(),
            channel,
            channel_password: null,
            peer_info: { osName: 'test', osVersion: '1', browserName: 'harness', browserVersion: '1', extras: {} },
            peer_uuid: peerUuid,
            peer_name: peerName,
            peer_avatar: '',
            peer_token: null,
            peer_video: true,
            peer_audio: true,
            peer_video_status: true,
            peer_audio_status: true,
            peer_screen_status: false,
            peer_hand_status: false,
            peer_rec_status: false,
            peer_privacy_status: false,
            userAgent: 'test-harness',
        });
    }

    close() {
        try {
            this.ws.close();
        } catch {
            /* already closed */
        }
    }
}

async function createCall(base, caller, inviteeIds, { deviceId, ...body } = {}) {
    const { status, data } = await api(base, caller, '/api/calls', {
        method: 'POST',
        body: { inviteeIds, ...body },
        headers: deviceId ? { 'x-crossbar-device': deviceId } : {},
    });
    if (status !== 201) throw new Error(`create call failed: ${status} ${JSON.stringify(data)}`);
    return data;
}

async function accept(base, who, callId) {
    const { status, data } = await api(base, who, `/api/calls/${callId}/respond`, {
        method: 'POST',
        body: { response: 'accepted' },
    });
    if (status !== 200) throw new Error(`accept failed: ${status} ${JSON.stringify(data)}`);
    return data;
}

module.exports = { startTestServer, api, TestPeer, createCall, accept, FAMILY, DEV_USERS };
