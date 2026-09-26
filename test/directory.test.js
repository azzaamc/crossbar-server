'use strict';

// The directory file, and what it is allowed to be. Every rule here is one whose absence
// would be either a server that will not start or a directory nobody can administer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = require('../src/directory');

const three = () => ({
    users: [
        { id: 'abdullah', tailscaleLogin: 'ibnfaisalc@gmail.com', displayName: 'Abdullah', admin: true },
        { id: 'dad', tailscaleLogin: 'faisalc@gmail.com', displayName: 'Dad' },
        { id: 'mum', tailscaleLogin: 'nadiabashir@gmail.com', displayName: 'Mum' },
    ],
    contacts: [{ ownerId: 'abdullah', contactId: 'dad', sortOrder: 1 }],
    groups: [{ id: 'everyone', displayName: 'Everyone', memberIds: ['abdullah', 'dad', 'mum'] }],
});

test('a person arrives with what the file needs, and nothing it does not', () => {
    const next = directory.validate(directory.withPerson(three(), {
        id: 'Sara',
        displayName: '  Sara  ',
        tailscaleLogin: 'Sara@Example.com',
        admin: false,
    }));
    const sara = next.users.find((user) => user.id === 'sara');
    assert.equal(sara.displayName, 'Sara');
    assert.equal(sara.tailscaleLogin, 'sara@example.com');
    assert.equal(sara.admin, undefined, 'nobody is an administrator by accident');
    assert.equal(next.users.length, 4);
});

test('somebody who arrives reaches everybody, and everybody reaches them', () => {
    const next = directory.withPerson(three(), { id: 'sara', displayName: 'Sara' });
    const reaches = (owner, contact) => next.contacts.some(
        (item) => item.ownerId === owner && item.contactId === contact,
    );

    // The console has no table of ticks any more, so this is where the graph stays complete:
    // somebody added to a directory is not left an island by the act of adding them.
    for (const other of ['abdullah', 'dad', 'mum']) {
        assert.ok(reaches('sara', other), `sara reaches ${other}`);
        assert.ok(reaches(other, 'sara'), `${other} reaches sara`);
    }

    // And what was already written down is kept rather than replaced.
    assert.ok(reaches('abdullah', 'dad'), 'the pair that was in the file is still there');
    assert.equal(next.contacts.length, 7, 'one pair, plus six for the person who arrived');
});

test('suspending is a field on the person, not a deletion of them', () => {
    const next = directory.validate(directory.withChanges(three(), 'dad', { enabled: false }));
    assert.equal(next.users.find((user) => user.id === 'dad').enabled, false);
    assert.equal(next.users.length, 3, 'a suspended person is still in the file');
});

test('a directory keeps an administrator who is not suspended', () => {
    assert.throws(() => directory.validate(directory.withChanges(three(), 'abdullah', { enabled: false })),
        /administrator/);
    assert.throws(() => directory.validate(directory.withChanges(three(), 'abdullah', { admin: false })),
        /administrator/);
});

test('two people cannot claim one login, or one id', () => {
    assert.throws(
        () => directory.validate(directory.withPerson(three(),
            { id: 'other', displayName: 'Other', tailscaleLogin: 'FAISALC@gmail.com' })),
        /claim the login/);
    assert.throws(
        () => directory.withPerson(three(), { id: 'Dad', displayName: 'Dad again', tailscaleLogin: 'x@y.z' }),
        /already someone/);
});

test('removing somebody takes their contacts and group membership with them', () => {
    const next = directory.validate(directory.withoutPerson(three(), 'dad'));
    assert.deepEqual(next.users.map((user) => user.id), ['abdullah', 'mum']);
    assert.deepEqual(next.contacts, [], 'a contact of somebody gone is a reference to nobody');
    assert.deepEqual(next.groups[0].memberIds, ['abdullah', 'mum']);
});

test('writing replaces the file in one move, and keeps the version before it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-directory-'));
    const file = path.join(dir, 'directory.json');
    directory.write(file, three());
    directory.write(file, directory.withoutPerson(three(), 'dad'));

    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).users.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(directory.backupPath(file), 'utf8')).users.length, 3);
    assert.equal(fs.existsSync(`${file}.writing`), false, 'nothing is left half-written');
});

test('a login is required where it is how people are found, and optional where it is not', () => {
    const added = directory.withPerson(three(), { id: 'sara', displayName: 'Sara' });

    // Where a tailnet proxy names the caller, a person with no login is a person nobody
    // can ever reach, so the file refuses it.
    assert.throws(() => directory.validate(added), /no login/);

    // Where a device proves itself with a key, a login is a record of who somebody is
    // elsewhere — and a directory whose people have no tailnet has none to write down.
    const relaxed = directory.validate(added, { requireLogins: false });
    assert.equal(relaxed.users.length, 4);
    assert.equal(relaxed.users.find((user) => user.id === 'sara').tailscaleLogin, undefined,
        'a login that was never given is absent, not empty');
});

test('a directory where nobody has a login at all is a directory with no tailnet in it', () => {
    const noTailnet = {
        users: [
            { id: 'sara', displayName: 'Sara', admin: true },
            { id: 'omar', displayName: 'Omar' },
        ],
    };
    assert.equal(directory.validate(noTailnet, { requireLogins: false }).users.length, 2);
    assert.throws(() => directory.validate(noTailnet), /no login/);
});

test('a login that is there is still held by one person only', () => {
    assert.throws(
        () => directory.validate(
            directory.withPerson(three(), { id: 'sara', displayName: 'Sara', tailscaleLogin: 'FAISALC@gmail.com' }),
            { requireLogins: false },
        ),
        /claim the login/);
});

test('a login can be cleared, which is what leaving a tailnet looks like', () => {
    const cleared = directory.withChanges(three(), 'dad', { tailscaleLogin: '' });

    // Somebody who leaves the tailnet keeps their identity and their history, and stops
    // being found by a login.
    const relaxed = directory.validate(cleared, { requireLogins: false });
    assert.equal(relaxed.users.find((user) => user.id === 'dad').tailscaleLogin, undefined);

    // And where a login is how people are found, taking somebody's away is refused.
    assert.throws(() => directory.validate(cleared), /no login/);
});

test('reaching somebody is written in both directions, or it is not written', () => {
    const next = directory.withContact(three(), 'dad', 'mum');
    const pairs = next.contacts.map((contact) => `${contact.ownerId}→${contact.contactId}`);

    // A list where you appear to somebody who does not appear to you is a half-relationship
    // nobody asked for, and it would take an operator checking both cells to find it.
    assert.ok(pairs.includes('dad→mum'), `expected dad→mum in ${JSON.stringify(pairs)}`);
    assert.ok(pairs.includes('mum→dad'), `expected mum→dad in ${JSON.stringify(pairs)}`);
});

test('taking a pair away takes it both ways, whichever way it is named', () => {
    // Named in the order the pair was not written in, because removal is about the two
    // people rather than about a direction somebody happened to type.
    const severed = directory.withoutContact(three(), 'dad', 'abdullah');
    assert.deepEqual(severed.contacts, [], 'the only pair in the fixture mentioned both of them');
});

test('everybody connected is a complete graph, and replaces what was there', () => {
    const next = directory.withEveryoneConnected(three());
    assert.equal(next.contacts.length, 6, 'three people, each reaching the other two');
    assert.ok(!next.contacts.some((contact) => contact.ownerId === contact.contactId));
});

test('a contact has to name two people who are both here', () => {
    assert.throws(
        () => directory.validate({ ...three(), contacts: [{ ownerId: 'abdullah', contactId: 'nobody' }] }),
        /not in the directory/,
        'a row the database cannot hold should fail where it is written, not at the next start');
    assert.throws(
        () => directory.validate({ ...three(), contacts: [{ ownerId: 'dad', contactId: 'dad' }] }),
        /their own contact/);
    assert.throws(() => directory.withContact(three(), 'abdullah', 'nobody'), /nobody with the id/);
    assert.throws(() => directory.withContact(three(), 'dad', 'dad'), /cannot reach themselves/);
});
