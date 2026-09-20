'use strict';

// Protocol tests. The client here speaks the same frames the native client does,
// so these assert the contract rather than a convenient variant of it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, api, TestPeer, createCall, accept } = require('./helpers');

async function enrol(base, ...people) {
    for (const who of people) await api(base, who, '/api/session');
}

/** A two-person call, both admitted, with the caller joined first. */
async function joinedPair(base, { caller = 'abdullah@dev', invitee = 'dad@dev', callerDevice = 'device-aaaaaaaa' } = {}) {
    await enrol(base, caller, invitee);
    const created = await createCall(base, caller, [invitee.split('@')[0]], { deviceId: callerDevice });
    const answered = await accept(base, invitee, created.call.id);
    const room = new URL(answered.joinUrl).searchParams.get('room');

    const first = await TestPeer.connect(base, caller, { deviceId: callerDevice });
    await first.join({ channel: room, peerName: 'Abdullah' });
    await first.waitForEvent('serverInfo');

    const second = await TestPeer.connect(base, invitee, { deviceId: 'device-bbbbbbbb' });
    await second.join({ channel: room, peerName: 'Dad' });

    return { created, room, first, second };
}

test('a socket that presents no identity cannot join a room', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    await enrol(base, 'abdullah@dev', 'dad@dev');
    const created = await createCall(base, 'abdullah@dev', ['dad']);
    const room = new URL(created.joinUrl).searchParams.get('room');

    const anonymous = await TestPeer.connect(base, null);
    t.after(() => anonymous.close());
    await anonymous.join({ channel: room, peerName: 'Nobody' });

    const refusal = await anonymous.waitForEvent('unauthorized');
    assert.equal(refusal.payload.reason, 'no_identity');
    assert.equal(anonymous.received('addPeer').length, 0);
});

test('a person who is not in the call cannot join its room', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    await enrol(base, 'abdullah@dev', 'dad@dev', 'mum@dev');
    const created = await createCall(base, 'abdullah@dev', ['dad']);
    const room = new URL(created.joinUrl).searchParams.get('room');

    const outsider = await TestPeer.connect(base, 'mum@dev');
    t.after(() => outsider.close());
    await outsider.join({ channel: room, peerName: 'Mum' });

    const refusal = await outsider.waitForEvent('unauthorized');
    assert.equal(refusal.payload.reason, 'NOT_A_PARTICIPANT');
});

test('knowing a room name that does not exist gets nowhere', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    await enrol(base, 'abdullah@dev');

    const wanderer = await TestPeer.connect(base, 'abdullah@dev');
    t.after(() => wanderer.close());
    await wanderer.join({ channel: 'c0ffee00-0000-4000-8000-000000000000', peerName: 'Abdullah' });

    const refusal = await wanderer.waitForEvent('unauthorized');
    assert.equal(refusal.payload.reason, 'room_not_found');
});

test('the second peer to arrive is the offerer, and both are told the ICE configuration', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    const { first, second } = await joinedPair(base);
    t.after(() => {
        first.close();
        second.close();
    });

    const toFirst = await first.waitForEvent('addPeer');
    assert.equal(toFirst.payload.peer_id, second.sid);
    assert.equal(toFirst.payload.should_create_offer, false);
    assert.equal(toFirst.payload.peer_name, 'Dad');
    assert.deepEqual(toFirst.payload.iceServers, [{ urls: 'stun:example.invalid:3478' }]);

    const toSecond = await second.waitForEvent('addPeer');
    assert.equal(toSecond.payload.peer_id, first.sid);
    assert.equal(toSecond.payload.should_create_offer, true);
    assert.equal(toSecond.payload.peer_name, 'Abdullah');
});

test('an offer and its answer are relayed with the sender named by the server', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    const { first, second } = await joinedPair(base);
    t.after(() => {
        first.close();
        second.close();
    });

    first.emit('relaySDP', {
        peer_id: second.sid,
        session_description: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' },
    });
    const offer = await second.waitForEvent('sessionDescription');
    assert.equal(offer.payload.peer_id, first.sid, 'the server names the sender, not the sender');
    assert.equal(offer.payload.session_description.type, 'offer');

    second.emit('relayICE', {
        peer_id: first.sid,
        ice_candidate: { sdpMLineIndex: 0, candidate: 'candidate:1 1 UDP 1 127.0.0.1 1 typ host' },
    });
    const candidate = await first.waitForEvent('iceCandidate');
    assert.equal(candidate.payload.peer_id, second.sid);
    assert.match(candidate.payload.ice_candidate.candidate, /^candidate:/);
});

test('a relay addressed outside the sender call is refused', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    await enrol(base, 'abdullah@dev', 'dad@dev', 'mum@dev');

    // Two separate calls, both involving Abdullah, so a real peer id exists on each.
    const withDad = await createCall(base, 'abdullah@dev', ['dad']);
    const dadRoom = new URL(await accept(base, 'dad@dev', withDad.call.id).then((r) => r.joinUrl)).searchParams.get('room');
    const withMum = await createCall(base, 'abdullah@dev', ['mum']);
    const mumRoom = new URL(await accept(base, 'mum@dev', withMum.call.id).then((r) => r.joinUrl)).searchParams.get('room');

    const abdullahInDadCall = await TestPeer.connect(base, 'abdullah@dev', { deviceId: 'device-aaaaaaaa' });
    const dad = await TestPeer.connect(base, 'dad@dev', { deviceId: 'device-bbbbbbbb' });
    const mum = await TestPeer.connect(base, 'mum@dev', { deviceId: 'device-cccccccc' });
    t.after(() => {
        abdullahInDadCall.close();
        dad.close();
        mum.close();
    });

    await abdullahInDadCall.join({ channel: dadRoom, peerName: 'Abdullah' });
    await dad.join({ channel: dadRoom, peerName: 'Dad' });
    await mum.join({ channel: mumRoom, peerName: 'Mum' });
    await mum.waitForEvent('serverInfo');

    // Into the other call: the target exists and is connected, but not here.
    abdullahInDadCall.emit('relaySDP', {
        peer_id: mum.sid,
        session_description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    abdullahInDadCall.emit('relayICE', {
        peer_id: mum.sid,
        ice_candidate: { sdpMLineIndex: 0, candidate: 'candidate:1 1 UDP 1 127.0.0.1 1 typ host' },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(mum.received('sessionDescription').length, 0, 'nothing may cross between calls');
    assert.equal(mum.received('iceCandidate').length, 0);

    // The same message inside the call does arrive, so the refusal is about scope.
    abdullahInDadCall.emit('relaySDP', {
        peer_id: dad.sid,
        session_description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    const delivered = await dad.waitForEvent('sessionDescription');
    assert.equal(delivered.payload.peer_id, abdullahInDadCall.sid);
});

test('a peer may not announce another peer as itself', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    const { first, second, room } = await joinedPair(base);
    t.after(() => {
        first.close();
        second.close();
    });

    second.emit('peerStatus', {
        room_id: room,
        peer_name: 'Abdullah',
        peer_id: first.sid, // claiming to be the other peer
        element: 'video',
        status: false,
        extras: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(first.received('peerStatus').length, 0, 'a peer cannot speak for another');

    second.emit('peerStatus', {
        room_id: room,
        peer_name: 'Dad',
        peer_id: second.sid,
        element: 'video',
        status: false,
        extras: {},
    });
    const status = await first.waitForEvent('peerStatus');
    assert.equal(status.payload.peer_id, second.sid);
    assert.equal(status.payload.status, false);
    assert.equal(status.payload.room_id, undefined, 'the room is stripped from the broadcast');
});

test('a malformed relay cannot take the server down', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    const { first, second, room } = await joinedPair(base);
    t.after(() => {
        first.close();
        second.close();
    });

    // The exact shape that used to crash the old server outright: a prototype key
    // reaching a relay, plus payloads with no shape at all.
    first.emit('relayICE', { peer_id: 'constructor', ice_candidate: {} });
    first.emit('relaySDP', { peer_id: 'toString', session_description: { type: 'offer' } });
    first.emit('relaySDP', { peer_id: second.sid, session_description: { type: 'nonsense', sdp: 'x' } });
    first.emit('relayICE', { peer_id: second.sid, ice_candidate: { candidate: 'not-a-candidate' } });
    first.send('42not json at all');
    first.send('9nonsense');
    first.send('');

    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(second.received('sessionDescription').length, 0);
    assert.equal(second.received('iceCandidate').length, 0);

    // The process still serves: a fresh person can still be admitted to the call.
    const stillWorking = await api(base, 'abdullah@dev', '/api/session');
    assert.equal(stillWorking.status, 200);

    const third = await TestPeer.connect(base, 'dad@dev', { deviceId: 'device-dddddddd' });
    t.after(() => third.close());
    await third.join({ channel: room, peerName: 'Dad' });
    const admitted = await third.waitForEvent('serverInfo');
    assert.ok(admitted.payload.peers_count >= 1, 'the server is still admitting peers');
});

test('the server keeps the connection alive with its own pings', async (t) => {
    const { server, base } = await startTestServer({ pingIntervalMs: 120, pingTimeoutMs: 5000 });
    t.after(() => server.close());
    await enrol(base, 'abdullah@dev');

    const peer = await TestPeer.connect(base, 'abdullah@dev');
    t.after(() => peer.close());
    await peer.waitFor(() => peer.pings > 0, 'a ping', 2000);
    assert.ok(peer.pings > 0);
});

test('a room refuses more participants than its ceiling', async (t) => {
    const { server, base } = await startTestServer({ maxParticipants: 2 });
    t.after(() => server.close());
    await enrol(base, 'abdullah@dev', 'dad@dev', 'mum@dev');
    const created = await createCall(base, 'abdullah@dev', ['dad', 'mum']);
    const room = new URL(created.joinUrl).searchParams.get('room');
    await accept(base, 'dad@dev', created.call.id);
    await accept(base, 'mum@dev', created.call.id);

    const first = await TestPeer.connect(base, 'abdullah@dev', { deviceId: 'device-aaaaaaaa' });
    const second = await TestPeer.connect(base, 'dad@dev', { deviceId: 'device-bbbbbbbb' });
    const third = await TestPeer.connect(base, 'mum@dev', { deviceId: 'device-cccccccc' });
    t.after(() => {
        first.close();
        second.close();
        third.close();
    });

    await first.join({ channel: room, peerName: 'Abdullah' });
    await second.join({ channel: room, peerName: 'Dad' });
    await third.join({ channel: room, peerName: 'Mum' });

    const refusal = await third.waitForEvent('unauthorized');
    assert.equal(refusal.payload.reason, 'room_full');
});

test('a device that reconnects replaces its own previous connection', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    const { room, first, second } = await joinedPair(base, { callerDevice: 'device-aaaaaaaa' });
    t.after(() => second.close());

    const reconnected = await TestPeer.connect(base, 'abdullah@dev', { deviceId: 'device-aaaaaaaa' });
    t.after(() => reconnected.close());
    await reconnected.join({ channel: room, peerName: 'Abdullah' });

    await first.waitForClose();
    const departure = await second.waitForEvent('removePeer', (event) => event.payload.peer_id === first.sid);
    assert.equal(departure.payload.peer_id, first.sid);
    const arrival = await second.waitForEvent('addPeer', (event) => event.payload.peer_id === reconnected.sid);
    assert.equal(arrival.payload.should_create_offer, false);
});

test('inviting yourself is refused unless self-calls are enabled', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    await enrol(base, 'abdullah@dev');

    const refused = await api(base, 'abdullah@dev', '/api/calls', {
        method: 'POST',
        body: { inviteeIds: ['abdullah'] },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.data.error.code, 'INVALID_INVITEES');
});

test('with self-calls enabled, a person can ring their own other devices', async (t) => {
    // One Tailscale account means every device of one person presents the same
    // identity, so this is the only way to place a call between two of them.
    const { server, base } = await startTestServer({ allowSelfCalls: true });
    t.after(() => server.close());
    await enrol(base, 'abdullah@dev');

    const created = await createCall(base, 'abdullah@dev', ['abdullah']);
    assert.equal(created.call.status, 'active', 'nobody to ring, so there is nothing to wait for');
    assert.equal(created.call.participants.length, 1, 'the caller is the only participant');
    const room = new URL(created.joinUrl).searchParams.get('room');

    const other = await api(base, 'abdullah@dev', '/api/bootstrap');
    assert.equal(other.data.ongoingCalls.length, 1, 'the second device finds it and can join');

    const phone = await TestPeer.connect(base, 'abdullah@dev', { deviceId: 'device-aaaaaaaa' });
    const laptop = await TestPeer.connect(base, 'abdullah@dev', { deviceId: 'device-bbbbbbbb' });
    t.after(() => {
        phone.close();
        laptop.close();
    });
    await phone.join({ channel: room, peerName: 'Abdullah' });
    await laptop.join({ channel: room, peerName: 'Abdullah' });

    const toPhone = await phone.waitForEvent('addPeer');
    assert.equal(toPhone.payload.peer_id, laptop.sid);
    assert.equal(toPhone.payload.should_create_offer, false);
    const toLaptop = await laptop.waitForEvent('addPeer');
    assert.equal(toLaptop.payload.should_create_offer, true, 'the second device offers');
});

test('a departing peer is announced to the peers left behind', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    const { first, second } = await joinedPair(base);
    t.after(() => first.close());

    second.close();
    const departure = await first.waitForEvent('removePeer', (event) => event.payload.peer_id === second.sid);
    assert.equal(departure.payload.peer_id, second.sid);
});
