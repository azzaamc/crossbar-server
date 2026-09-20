'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const machine = require('../src/calls');

const participant = (userId, status) => ({ userId, status });
const call = (status) => ({ status });

test('the first accept makes the call active, and a second accept leaves it there', () => {
    assert.equal(machine.statusAfterAccept(call('ringing')), 'active');
    assert.equal(machine.statusAfterAccept(call('active')), 'active');
});

test('a decline only ends the call when nobody can still answer', () => {
    const stillWaiting = [participant('a', 'accepted'), participant('b', 'declined'), participant('c', 'invited')];
    assert.equal(machine.statusAfterDecline(call('ringing'), stillWaiting), 'ringing');

    const nobodyLeft = [participant('a', 'accepted'), participant('b', 'declined'), participant('c', 'declined')];
    assert.equal(
        machine.statusAfterDecline(call('ringing'), nobodyLeft),
        'declined',
        'the caller waiting is not a reason to keep ringing',
    );

    const onlyDeclines = [participant('b', 'declined'), participant('c', 'declined')];
    assert.equal(machine.statusAfterDecline(call('ringing'), onlyDeclines), 'declined');

    assert.equal(
        machine.statusAfterDecline(call('active'), nobodyLeft),
        'active',
        'a call that was answered does not become declined',
    );
});

test('one participant leaving does not end a call others are still in', () => {
    const remaining = [participant('a', 'left'), participant('b', 'accepted'), participant('c', 'accepted')];
    assert.equal(machine.shouldEndAfterLeave(remaining), false);
});

test('the call ends when the last participant leaves', () => {
    const empty = [participant('a', 'left'), participant('b', 'declined'), participant('c', 'cancelled')];
    assert.equal(machine.shouldEndAfterLeave(empty), true);
});

test('ending a ringing call cancels it and ending a live one ends it', () => {
    assert.equal(machine.statusAfterEnd(call('ringing')), 'cancelled');
    assert.equal(machine.statusAfterEnd(call('active')), 'ended');
});

test('only an unanswered invitation can be answered', () => {
    assert.equal(machine.canRespond(participant('a', 'invited')), true);
    assert.equal(machine.canRespond(participant('a', 'accepted')), false);
    assert.equal(machine.canRespond(participant('a', 'declined')), false);
    assert.equal(machine.canRespond(null), false);
});

test('joining is refused with a reason that says which rule applied', () => {
    assert.equal(machine.joinRefusal(null, participant('a', 'accepted')), 'CALL_NOT_FOUND');
    assert.equal(machine.joinRefusal(call('active'), null), 'NOT_A_PARTICIPANT');
    assert.equal(machine.joinRefusal(call('active'), participant('a', 'accepted')), null);
    assert.equal(
        machine.joinRefusal(call('active'), participant('a', 'left')),
        null,
        'someone who left a call that is still up may come back to it',
    );
    assert.equal(machine.joinRefusal(call('ringing'), participant('a', 'accepted')), null);
    assert.equal(machine.joinRefusal(call('ringing'), participant('a', 'invited')), 'CALL_NOT_JOINABLE');
    assert.equal(machine.joinRefusal(call('ended'), participant('a', 'accepted')), 'CALL_NOT_JOINABLE');
    assert.equal(machine.joinRefusal(call('missed'), participant('a', 'accepted')), 'CALL_NOT_JOINABLE');
});

test('only an accepted participant may add someone to the call', () => {
    assert.equal(machine.canInvite(call('active'), participant('a', 'accepted')), true);
    assert.equal(machine.canInvite(call('ringing'), participant('a', 'accepted')), true);
    assert.equal(machine.canInvite(call('active'), participant('a', 'left')), false);
    assert.equal(machine.canInvite(call('ended'), participant('a', 'accepted')), false);
    assert.equal(machine.canInvite(null, participant('a', 'accepted')), false);
});
