'use strict';

// The server's half of relay failure recovery, which is about the two things an answered
// request makes easy and an unanswered one makes hard:
//
//   * a ring whose answer never came back. The relay recorded what became of it, so the
//     repeat carries the same derived `request_id` and is answered from that record — which
//     is how a `410 device_unregistered` that was lost on the way back is learned at all;
//   * a removal whose answer never came back. The relay still holds the phone's PushKit
//     token, and it stays held until the relay itself says otherwise, so the request is
//     durable and a sweep retries it past refusals, outages and the local row's removal.
//
// A stand-in relay answers, refuses, or never answers at all; a real one would ring a phone.
// The stub here is local to the file, like the client's own test file has its own, so neither
// stops proving its subject when the other changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { Store } = require('../src/db');
const { createPushRelayClient, requestIdFor } = require('../src/pushrelay');
const { startTestServer, api, createCall, DIRECTORY } = require('./helpers');

/** A credential of the shape the relay issues. */
const TOKEN = `cbr_${'A'.repeat(43)}`;
const DEVICE_ID = 'dev_RhB3R7UuH9TqbmBJ';
const VOIP_TOKEN = 'ab'.repeat(32);

/** A moment this far ahead, so that anything the queue is holding at all is due by then. */
const ahead = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();

/**
 * A stand-in relay: a real HTTP server, one recorded request per call, one answer per entry.
 *
 * `answers` is a queue consumed in order, and anything past its end answers `200 {ok:true}`.
 * `destroy` drops the socket — the relay that received the request and whose answer never
 * came back, which is the failure this file exists for.
 */
async function startStubRelay(answers = []) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null });
            const answer = answers.shift() || { status: 200, body: { ok: true } };
            if (answer.destroy) return req.socket.destroy();
            res.writeHead(answer.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(answer.body ?? {}));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        requests,
        url: `http://127.0.0.1:${server.address().port}`,
        rings: () => requests.filter((request) => request.path === '/v1/push/voip'),
        removals: () => requests.filter((request) => request.method === 'DELETE'),
        async close() {
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

/** Up to two seconds for the fire-and-forget work a call starts. */
async function settle(check, label) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(check(), label);
}

/** A phone that has told this server where to ring it, by the routes the app uses. */
async function enrolPhone(base, deviceId) {
    const registered = await api(base, 'dad@dev', '/api/devices', {
        method: 'POST',
        body: { deviceId, label: 'Dad', platform: 'ios' },
    });
    assert.ok([200, 201].includes(registered.status), `setup: the device is registered (${registered.status})`);
    const saved = await api(base, 'dad@dev', '/api/devices/push-token', {
        method: 'POST',
        body: { deviceId, token: VOIP_TOKEN, environment: 'production', kind: 'voip' },
    });
    assert.equal(saved.status, 200, 'setup: the VoIP token is stored');
}

/** A server wired to the stub relay. */
async function startRelayedServer(t, stub) {
    const started = await startTestServer({
        pushRelayUrl: stub.url,
        pushRelayToken: TOKEN,
        pushRelayInstallationId: 'ins_test',
        pushRelayTimeoutMs: 2000,
    });
    t.after(() => started.server.close());
    return started;
}

// ── A ring whose answer was lost (REL-RELAY-02) ─────────────────────────────────

test('a ring the relay never answered is repeated with the same request_id, and the recorded answer is what returns', async (t) => {
    const stub = await startStubRelay([
        { status: 200, body: { ok: true, registered: true } },
        // The ring reaches the relay, APNs refuses the token, and the `410` never makes it
        // back: the relay has marked the device inactive and this server does not know.
        { destroy: true },
        // The repeat is answered from the relay's own record of the first attempt — the `410`
        // that was lost, with no second push.
        { status: 410, body: { error: 'device_unregistered' } },
    ]);
    t.after(() => stub.close());
    const { server, base } = await startRelayedServer(t, stub);

    await enrolPhone(base, DEVICE_ID);
    assert.equal(server.store.voipTokensFor(['dad']).length, 1, 'setup: the phone is ringable');

    const created = await createCall(base, 'abdullah@dev', ['dad']);
    await settle(() => server.store.voipTokensFor(['dad']).length === 0,
        'the replayed refusal cleared the token the relay will never ring again');

    const rings = stub.rings();
    assert.equal(rings.length, 2, 'an unanswered attempt is repeated exactly once');
    // The repeat has to be the *same* request: the same derived id is what makes the relay
    // answer it from the record instead of ringing the phone a second time.
    assert.equal(rings[0].body.request_id, requestIdFor(created.call.id, DEVICE_ID));
    assert.deepEqual(rings[1].body, rings[0].body);
    // And the call is untouched: the ring is a doorbell, and a doorbell that fails does not
    // end a call.
    assert.equal(server.store.callById(created.call.id).status, 'ringing');
});

test('a relay 404 is the same evidence as a 410, and the dead token goes without a repeat', async (t) => {
    const stub = await startStubRelay([
        { status: 200, body: { ok: true, registered: true } },
        // The device is not registered here: it never was, it was removed, or an APNs refusal
        // with a lost answer marked it inactive (relay docs/API.md, `POST /v1/push/voip`).
        { status: 404, body: { error: 'not_found' } },
    ]);
    t.after(() => stub.close());
    const { server, base } = await startRelayedServer(t, stub);

    await enrolPhone(base, DEVICE_ID);
    await createCall(base, 'abdullah@dev', ['dad']);
    await settle(() => server.store.voipTokensFor(['dad']).length === 0,
        'a device the relay does not have is not ringable either');

    assert.equal(stub.rings().length, 1, 'the relay answered, so there is nothing left to ask');
});

// ── A removal whose answer was lost (REL-RELAY-03) ──────────────────────────────

test('a removal the relay says it does not have is done, and leaves nothing owed', async (t) => {
    const stub = await startStubRelay([
        { status: 200, body: { ok: true, registered: true } },
        // "Not registered to this installation — either because it never was, or because it
        // has already been removed" (relay docs/API.md, `DELETE /v1/devices/{id}`).
        { status: 404, body: { error: 'not_found' } },
    ]);
    t.after(() => stub.close());
    const { server, base } = await startRelayedServer(t, stub);
    await enrolPhone(base, DEVICE_ID);

    const result = await server.lifecycle.forgetDeviceAtRelay(DEVICE_ID);

    assert.equal(result.configured, true);
    assert.equal(result.queued, false, '404 is the relay having nothing to remove');
    assert.equal(result.outcome.status, 404);
    const [removal] = stub.removals();
    assert.equal(removal.path, `/v1/devices/${DEVICE_ID}`);
    assert.deepEqual(server.store.pendingRelayDeletions(ahead(24), 10), [], 'nothing is owed');
});

test('an owed removal outlives a refusal, an outage and the device row itself, and lands when the relay answers', async (t) => {
    const stub = await startStubRelay([
        { status: 200, body: { ok: true, registered: true } },
        { status: 500, body: { error: 'internal' } },
        { destroy: true },
        { status: 200, body: { ok: true, device_id: DEVICE_ID, removed: true } },
    ]);
    t.after(() => stub.close());
    const { server, base } = await startRelayedServer(t, stub);
    await enrolPhone(base, DEVICE_ID);

    // The order a replaced phone is retired in: revoked, then taken out of the records. The
    // row the removal is *about* goes with the second step, and the removal itself does not.
    const revoked = server.store.revokeDevice(DEVICE_ID, new Date().toISOString());
    assert.equal(revoked, true);
    assert.equal(server.store.removeDevice(DEVICE_ID), true);
    assert.equal(server.store.deviceById(DEVICE_ID), null);
    assert.equal(server.store.pendingRelayDeletions(ahead(24), 10).length, 1,
        'the relay is still owed the deletion, with no device row left to learn it from');

    // A relay that answered and refused: not a removal, however permanent a 500 looks.
    const before = new Date().toISOString();
    const refused = await server.lifecycle.retryPendingRelayDeletions();
    assert.deepEqual(refused.settled, []);
    assert.deepEqual(refused.pending, [DEVICE_ID], 'a 500 is not a removal');
    assert.deepEqual(server.store.pendingRelayDeletions(before, 10), [],
        'and the next attempt is scheduled rather than immediate');

    // A relay that received the request and never answered.
    const outage = await server.lifecycle.retryPendingRelayDeletions({ at: ahead(24) });
    assert.deepEqual(outage.pending, [DEVICE_ID], 'a request that got no answer is not a removal either');

    // And then the relay answers.
    const landed = await server.lifecycle.retryPendingRelayDeletions({ at: ahead(24 * 7) });
    assert.deepEqual(landed.settled, [DEVICE_ID]);
    assert.deepEqual(server.store.pendingRelayDeletions(ahead(24 * 8), 10), [], 'and it is done');

    assert.deepEqual(stub.removals().map((request) => request.path),
        [`/v1/devices/${DEVICE_ID}`, `/v1/devices/${DEVICE_ID}`, `/v1/devices/${DEVICE_ID}`],
        'every attempt asked the relay to remove the same device');
});

test('without a relay there is nothing to ask and nothing to retry', async (t) => {
    const { server, base } = await startTestServer({ pushRelayUrl: '', pushRelayToken: '' });
    t.after(() => server.close());
    await enrolPhone(base, DEVICE_ID);

    assert.equal(server.store.revokeDevice(DEVICE_ID, new Date().toISOString()), true);
    // The revocation still records what it owes — the row is the request, and it costs one
    // row — but with no relay there is nobody to ask. Nothing is attempted and nothing is
    // cleared, so a deployment that is given a relay later finds the removal waiting.
    assert.equal(server.store.pendingRelayDeletions(ahead(24), 10).length, 1);
    const sweep = await server.lifecycle.retryPendingRelayDeletions();
    assert.deepEqual([sweep.configured, sweep.attempted, sweep.settled, sweep.pending], [false, 0, [], []]);
    assert.deepEqual(await server.lifecycle.forgetDeviceAtRelay(DEVICE_ID),
        { configured: false, queued: false, outcome: null });
    assert.equal(server.store.pendingRelayDeletions(ahead(24), 10).length, 1,
        'the row is neither attempted nor dropped');
});

// ── A plaintext relay (SEC-RELAY-06) ───────────────────────────────────────────

test('a plaintext relay is refused unless it is on this machine, and the scheme is named', async () => {
    const clientFor = (url) => {
        const records = [];
        return {
            records,
            client: createPushRelayClient({
                config: { pushRelayUrl: url, pushRelayToken: TOKEN, pushRelayTimeoutMs: 500 },
                log: { warn: (event, fields) => records.push({ event, fields }), info() {}, error() {}, debug() {} },
            }),
        };
    };

    // `https:` carries the installation credential off this machine, and a plaintext origin on
    // it is the one `http:` that has nowhere to leak to: a relay run locally, and the mock the
    // contract tests point at.
    for (const url of ['https://relay.example.com', 'https://relay.example.com:8443',
        'http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080']) {
        const { client, records } = clientFor(url);
        assert.equal(client.enabled, true, `${url} is reachable`);
        assert.deepEqual(records, [], `${url} is not refused`);
    }

    for (const url of ['http://relay.example.com', 'http://10.0.0.5:8080', 'http://127.0.0.1.example.com']) {
        const { client, records } = clientFor(url);
        assert.equal(client.enabled, false, `${url} is not spoken to`);
        // The refusal is at construction, and it names the scheme it will not use and why:
        // every registration and every ring would carry the credential in cleartext.
        assert.equal(records.length, 1);
        assert.equal(records[0].event, 'push_relay_origin_refused');
        assert.equal(records[0].fields.scheme, 'http:');
        assert.equal(records[0].fields.reason, 'plaintext');
        assert.match(records[0].fields.message, /cleartext/);
        assert.deepEqual(
            await client.registerDevice({ deviceId: DEVICE_ID, token: VOIP_TOKEN }),
            { ok: false, status: 0, error: 'not_configured', retryAfterSeconds: null, permanent: true, deviceGone: false, body: null },
        );
    }

    // Anything that is not HTTPS at all, named the same way.
    const { client: ftp, records: ftpRecords } = clientFor('ftp://relay.example.com');
    assert.equal(ftp.enabled, false);
    assert.deepEqual([ftpRecords[0].event, ftpRecords[0].fields.scheme, ftpRecords[0].fields.reason],
        ['push_relay_origin_refused', 'ftp:', 'not_http']);
});

// ── The migration (v7) ─────────────────────────────────────────────────────────

test('a database written before the queue existed gains it, and keeps everything it had', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-relay-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'directory.json');
    fs.writeFileSync(file, JSON.stringify(DIRECTORY));

    const dbPath = path.join(dir, 'crossbar.sqlite');
    const before = new Store(dir, file);
    const now = new Date().toISOString();
    before.registerDevice({ userId: 'dad', deviceId: DEVICE_ID, label: 'Dad', platform: 'ios', now });
    before.savePushToken({ deviceId: DEVICE_ID, token: VOIP_TOKEN, environment: 'production', kind: 'voip', now });
    // The shape a database from before this migration has: the table is not there, and the
    // version number is the one the migration before it wrote.
    before.db.exec('DROP TABLE pending_relay_deletions; PRAGMA user_version = 6;');
    before.close();

    // Opening the store again is what migrates it — and it is the only path an existing
    // deployment ever takes, so it is the one worth proving.
    const after = new Store(dir, file);
    try {
        assert.deepEqual(after.pendingRelayDeletions(now, 10), [], 'v7 created the table');
        assert.equal(after.deviceIdentity(DEVICE_ID).status, 'active', 'and left the devices alone');
    } finally {
        after.close();
    }
    const stored = new DatabaseSync(dbPath);
    try {
        assert.equal(stored.prepare('PRAGMA user_version').get().user_version, 7);
    } finally {
        stored.close();
    }
});
