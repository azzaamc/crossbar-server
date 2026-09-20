'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, api, createCall, accept } = require('./helpers');

/** Reads an SSE stream until `predicate` matches or the deadline passes. */
async function readEventStream(base, who, predicate, timeout = 4000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(`${base}/api/events`, {
        headers: { 'x-dev-identity': who },
        signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() ?? '';
            for (const block of blocks) {
                const name = /^event: (.+)$/m.exec(block)?.[1];
                const data = /^data: (.+)$/m.exec(block)?.[1];
                if (!name) continue;
                if (predicate(name, data)) return { name, data: data ? JSON.parse(data) : null };
            }
        }
    } catch {
        /* aborted, or the stream ended */
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
    return null;
}

test('a request with no trusted identity is refused', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    const anonymous = await api(base, null, '/api/session');
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.data.authenticated, false);

    const bootstrap = await api(base, null, '/api/bootstrap');
    assert.equal(bootstrap.status, 401);
    assert.equal(bootstrap.data.error.code, 'IDENTITY_MISSING');
});

test('a login the household file pins is the identity that person gets', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    const session = await api(base, 'dad@dev', '/api/session');
    assert.equal(session.data.authenticated, true);
    assert.equal(session.data.configured, true);
    assert.equal(session.data.user.id, 'dad', 'the configured id, not a derived one');
    assert.equal(session.data.user.displayName, 'Dad');
});

test('with auto-enrolment off, an unknown login is refused rather than enrolled', async (t) => {
    const { server, base } = await startTestServer({
        autoEnrolIdentities: false,
        devIdentities: ['abdullah@dev', 'dad@dev', 'mum@dev', 'stranger@dev'],
    });
    t.after(() => server.close());

    const stranger = await api(base, 'stranger@dev', '/api/bootstrap');
    assert.equal(stranger.status, 403);
    assert.equal(stranger.data.error.code, 'IDENTITY_NOT_ENROLLED');

    const session = await api(base, 'stranger@dev', '/api/session');
    assert.equal(session.data.authenticated, true, 'the identity is trusted');
    assert.equal(session.data.configured, false, 'but it is not a member of this household');
});

test('with auto-enrolment on, a new tailnet login joins and becomes discoverable', async (t) => {
    const { server, base } = await startTestServer({
        devIdentities: ['abdullah@dev', 'dad@dev', 'mum@dev', 'newphone@dev'],
    });
    t.after(() => server.close());

    await api(base, 'abdullah@dev', '/api/session');
    const enrolled = await api(base, 'newphone@dev', '/api/session');
    assert.equal(enrolled.data.configured, true, 'the tailnet is the perimeter');
    assert.match(enrolled.data.user.id, /^ts_[0-9a-f]{24}$/, 'enrolled under a derived id');

    const abdullahsView = await api(base, 'abdullah@dev', '/api/bootstrap');
    assert.ok(
        abdullahsView.data.contacts.some((contact) => contact.id === enrolled.data.user.id),
        'and is now in the directory of everyone who has signed in',
    );
});

test('bootstrap carries the directory, the groups and the calls of the person asking', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    await api(base, 'abdullah@dev', '/api/session'); // enrols on first sight
    await api(base, 'dad@dev', '/api/session');
    const call = await createCall(base, 'abdullah@dev', ['dad']);

    const bootstrap = await api(base, 'dad@dev', '/api/bootstrap');
    assert.equal(bootstrap.status, 200);
    assert.deepEqual(bootstrap.data.user.displayName, 'Dad');
    assert.deepEqual(
        bootstrap.data.contacts.map((contact) => contact.id),
        ['abdullah'],
        'only people who have signed in at least once are in the directory',
    );
    assert.equal(bootstrap.data.groups[0].id, 'family');
    assert.equal(bootstrap.data.calls.length, 1);
    assert.equal(bootstrap.data.calls[0].myStatus, 'invited');
    assert.equal(bootstrap.data.calls[0].id, call.call.id);

    // Mum becomes discoverable once she has signed in, and not before.
    await api(base, 'mum@dev', '/api/session');
    const afterMum = await api(base, 'dad@dev', '/api/bootstrap');
    assert.deepEqual(afterMum.data.contacts.map((contact) => contact.id).sort(), ['abdullah', 'mum']);
});

test('ringing reaches the invitee on the event stream', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    await api(base, 'abdullah@dev', '/api/session');
    await api(base, 'dad@dev', '/api/session');

    const pending = readEventStream(base, 'dad@dev', (name) => name === 'incoming-call');
    await new Promise((resolve) => setTimeout(resolve, 150)); // let the stream attach
    const created = await createCall(base, 'abdullah@dev', ['dad']);

    const event = await pending;
    assert.ok(event, 'the invitee should have been rung');
    assert.equal(event.data.id, created.call.id);
    assert.equal(event.data.status, 'ringing');
});

test('answering makes the call active and hands back where to join', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    await api(base, 'abdullah@dev', '/api/session');
    await api(base, 'dad@dev', '/api/session');
    const created = await createCall(base, 'abdullah@dev', ['dad']);

    const answered = await accept(base, 'dad@dev', created.call.id);
    assert.equal(answered.call.status, 'active');
    assert.match(answered.joinUrl, /\/call\?call=/);
    assert.match(answered.joinUrl, /room=/);
    assert.equal(answered.signalling.eio, 4);
    assert.equal(answered.signalling.room, new URL(answered.joinUrl).searchParams.get('room'));
});

test('an invitation cannot be answered twice', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    await api(base, 'abdullah@dev', '/api/session');
    await api(base, 'dad@dev', '/api/session');
    const created = await createCall(base, 'abdullah@dev', ['dad']);
    await accept(base, 'dad@dev', created.call.id);

    const again = await api(base, 'dad@dev', `/api/calls/${created.call.id}/respond`, {
        method: 'POST',
        body: { response: 'accepted' },
    });
    assert.equal(again.status, 409);
    assert.equal(again.data.error.code, 'ALREADY_RESPONDED');
});

test('declining with nobody left marks the call declined', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    await api(base, 'abdullah@dev', '/api/session');
    await api(base, 'dad@dev', '/api/session');
    const created = await createCall(base, 'abdullah@dev', ['dad']);

    const declined = await api(base, 'dad@dev', `/api/calls/${created.call.id}/respond`, {
        method: 'POST',
        body: { response: 'declined' },
    });
    assert.equal(declined.status, 200);
    assert.equal(declined.data.call.status, 'declined');
    assert.equal(declined.data.joinUrl, undefined, 'a declined invitation has nowhere to join');
});

test('one participant leaving keeps the call, and the last one ends it', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    for (const who of ['abdullah@dev', 'dad@dev', 'mum@dev']) await api(base, who, '/api/session');
    const created = await createCall(base, 'abdullah@dev', ['dad', 'mum']);
    await accept(base, 'dad@dev', created.call.id);
    await accept(base, 'mum@dev', created.call.id);

    const first = await api(base, 'dad@dev', `/api/calls/${created.call.id}/leave`, { method: 'POST' });
    assert.equal(first.status, 200);
    assert.equal(first.data.ended, false, 'two people are still in the call');
    assert.equal(first.data.call.status, 'active');

    const second = await api(base, 'mum@dev', `/api/calls/${created.call.id}/leave`, { method: 'POST' });
    assert.equal(second.data.ended, false, 'the caller is still in the call');
    assert.equal(second.data.call.status, 'active');

    const last = await api(base, 'abdullah@dev', `/api/calls/${created.call.id}/leave`, { method: 'POST' });
    assert.equal(last.data.ended, true);
    assert.equal(last.data.call.status, 'ended');
});

test('adding a person to an active call invites them into the same call', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    for (const who of ['abdullah@dev', 'dad@dev', 'mum@dev']) await api(base, who, '/api/session');
    const created = await createCall(base, 'abdullah@dev', ['dad']);
    await accept(base, 'dad@dev', created.call.id);

    const invited = await api(base, 'dad@dev', `/api/calls/${created.call.id}/invite`, {
        method: 'POST',
        body: { inviteeIds: ['mum'] },
    });
    assert.equal(invited.status, 200);
    assert.deepEqual(invited.data.added, ['mum']);

    const mumCall = await api(base, 'mum@dev', `/api/calls/${created.call.id}`);
    assert.equal(mumCall.status, 200);
    assert.equal(mumCall.data.call.participants.find((item) => item.userId === 'mum').status, 'invited');
});

test('ongoing calls are scoped to the device that joined them', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    await api(base, 'abdullah@dev', '/api/session', { headers: { 'x-crossbar-device': 'device-aaaaaaaa' } });
    await api(base, 'dad@dev', '/api/session', { headers: { 'x-crossbar-device': 'device-bbbbbbbb' } });
    for (const device of ['device-aaaaaaaa', 'device-bbbbbbbb']) {
        await api(base, 'dad@dev', '/api/devices', {
            method: 'POST',
            headers: { 'x-crossbar-device': device },
            body: { deviceId: device, label: device, platform: 'test' },
        });
    }

    const created = await createCall(base, 'abdullah@dev', ['dad'], { deviceId: 'device-aaaaaaaa' });
    assert.equal(created.call.status, 'ringing');
    await api(base, 'dad@dev', `/api/calls/${created.call.id}/respond`, {
        method: 'POST',
        headers: { 'x-crossbar-device': 'device-bbbbbbbb' },
        body: { response: 'accepted' },
    });
    await api(base, 'dad@dev', `/api/calls/${created.call.id}/join`, {
        method: 'POST',
        headers: { 'x-crossbar-device': 'device-bbbbbbbb' },
    });

    const onTheDevice = await api(base, 'dad@dev', '/api/bootstrap', {
        headers: { 'x-crossbar-device': 'device-bbbbbbbb' },
    });
    assert.equal(onTheDevice.data.ongoingCalls.length, 1, 'this device joined, so it is in the call');

    const onAnotherDevice = await api(base, 'dad@dev', '/api/bootstrap', {
        headers: { 'x-crossbar-device': 'device-cccccccc' },
    });
    assert.equal(onAnotherDevice.data.ongoingCalls.length, 0, 'a device that never joined must not resume it');
});

test('a mutation from another origin is refused', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    await api(base, 'abdullah@dev', '/api/session');
    const response = await api(base, 'abdullah@dev', '/api/calls', {
        method: 'POST',
        body: { inviteeIds: ['dad'] },
        headers: { origin: 'https://evil.example' },
    });
    assert.equal(response.status, 403);
    assert.equal(response.data.error.code, 'ORIGIN_REJECTED');
});

test('a call nobody answers expires as missed', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    await api(base, 'abdullah@dev', '/api/session');
    await api(base, 'dad@dev', '/api/session');
    const created = await createCall(base, 'abdullah@dev', ['dad']);

    const future = new Date(Date.now() + 60000).toISOString();
    const expired = server.store.expireCalls(future, new Date().toISOString());
    assert.deepEqual(expired, [created.call.id]);

    const after = await api(base, 'abdullah@dev', `/api/calls/${created.call.id}`);
    assert.equal(after.data.call.status, 'missed');
    assert.equal(
        after.data.call.participants.find((item) => item.userId === 'dad').status,
        'missed',
    );
});

test('the call client is served, and traversal out of the web root is refused', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    const page = await fetch(`${base}/call?call=x&room=y`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Crossbar call/);

    const script = await fetch(`${base}/call/call.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);

    const traversal = await fetch(`${base}/call/..%2f..%2f..%2fetc%2fpasswd`);
    assert.ok([400, 403, 404].includes(traversal.status), `expected a refusal, got ${traversal.status}`);
});
