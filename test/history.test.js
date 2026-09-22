'use strict';

// The one read the app needed the service to grow: a history.
//
// `/api/calls` answers only what is ringing or active, deliberately — that is what a client
// needs in order to rejoin a call. Recents asks the other question of the same records, and
// this is what holds the answer to it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, api } = require('./helpers');

test('the history reports finished calls, and only this person\'s', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());

    // Nobody has called anybody yet. An empty history is an answer, not a failure.
    const empty = await api(base, 'abdullah@dev', '/api/calls/history');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data.calls, []);

    // A contact counts once they have arrived: the directory is people who have signed in, so
    // somebody has to have done so before the service will ring them at all.
    await api(base, 'mum@dev', '/api/bootstrap');

    // A call that was placed and has finished is what the screen lists.
    const made = await api(base, 'abdullah@dev', '/api/calls', {
        method: 'POST',
        body: { inviteeIds: ['mum'] },
    });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const callId = made.data.call?.id ?? made.data.id;
    assert.ok(callId, `the created call has no id: ${JSON.stringify(made.data)}`);
    server.store.endCall(callId, 'abdullah', new Date().toISOString());

    const closed = await api(base, 'abdullah@dev', '/api/calls/history');
    assert.equal(closed.status, 200);
    assert.equal(closed.data.calls.length, 1);

    // Everything the Recents row draws, so it never has to guess at any of it.
    const [call] = closed.data.calls;
    assert.equal(call.callId, callId);
    assert.equal(call.callerId, 'abdullah');
    assert.equal(call.callerName, 'Abdullah');
    assert.ok(call.startedAt, 'a row with no time cannot be placed');
    for (const field of ['kind', 'myStatus', 'answeredAt', 'endedAt', 'joinedAt', 'leftAt', 'others']) {
        assert.ok(field in call, `the row needs ${field}`);
    }

    // A history is of *this* person's calls: somebody who was not on it has none.
    assert.deepEqual((await api(base, 'dad@dev', '/api/calls/history')).data.calls, []);
});
