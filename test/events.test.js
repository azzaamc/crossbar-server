'use strict';

// The event stream's presence contract.
//
// Presence is not stored here — the bus reports what it can see, which is how many
// streams a person holds. That makes the *edges* the whole of the logic, and the edges are
// where it went wrong: a client replacing its stream (which a pull-to-refresh does) cancels
// one and opens another, and the server can see those in either order. A broadcast that
// fires only when a count crosses zero then leaves the last word as whatever arrived
// second, and a phone that heard "offline" about somebody who is online has no reason to
// ask again. Measured on the first public deployment, 2026-09-21.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createEventBus } = require('../src/events');

const quiet = { warn() {}, info() {}, error() {} };

/// A response that records the events written to it, as a client would receive them.
function stream(into) {
    return {
        write(chunk) {
            const match = /^data: (.*)$/m.exec(String(chunk));
            if (match) into.push(JSON.parse(match[1]));
        },
    };
}

function bus() {
    return createEventBus({ store: { touchPresence() {} }, log: quiet });
}

const about = (events, userId) => events.filter((event) => event.userId === userId);

test('a person whose stream is replaced is never reported as having gone offline', () => {
    const received = [];
    const events = bus();

    // Somebody watching. Presence is fan-out, so there has to be a recipient.
    events.add('abdullah', stream(received));
    const stopOld = events.add('mum', stream([]));

    received.length = 0;
    // A refresh: the new stream opens first, and the old one is noticed afterwards. Both
    // orders have to end with the same answer.
    events.add('mum', stream([]));
    stopOld();

    const said = about(received, 'mum');
    assert.ok(said.length >= 1, 'her replacement is reported to the household');
    assert.ok(
        said.every((event) => event.online === true),
        `she was online throughout, and must never be announced as offline: ${JSON.stringify(said)}`,
    );
});

test('a person with no streams left is reported offline', () => {
    const received = [];
    const events = bus();

    events.add('abdullah', stream(received));
    const stop = events.add('mum', stream([]));

    received.length = 0;
    stop();

    const said = about(received, 'mum');
    assert.equal(said.length, 1, 'leaving is announced once');
    assert.equal(said[0].online, false);
});
