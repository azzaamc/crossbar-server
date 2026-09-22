'use strict';

// The household file, and what it is allowed to be. Every rule here is one whose absence
// would be either a server that will not start or a household nobody can administer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const household = require('../src/household');

const three = () => ({
    users: [
        { id: 'abdullah', tailscaleLogin: 'ibnfaisalc@gmail.com', displayName: 'Abdullah', admin: true },
        { id: 'dad', tailscaleLogin: 'faisalc@gmail.com', displayName: 'Dad' },
        { id: 'mum', tailscaleLogin: 'nadiabashir@gmail.com', displayName: 'Mum' },
    ],
    contacts: [{ ownerId: 'abdullah', contactId: 'dad', sortOrder: 1 }],
    groups: [{ id: 'family', displayName: 'Family', memberIds: ['abdullah', 'dad', 'mum'] }],
});

test('a person arrives with what the file needs, and nothing it does not', () => {
    const next = household.validate(household.withPerson(three(), {
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

test('suspending is a field on the person, not a deletion of them', () => {
    const next = household.validate(household.withChanges(three(), 'dad', { enabled: false }));
    assert.equal(next.users.find((user) => user.id === 'dad').enabled, false);
    assert.equal(next.users.length, 3, 'a suspended person is still in the file');
});

test('a household keeps an administrator who is not suspended', () => {
    assert.throws(() => household.validate(household.withChanges(three(), 'abdullah', { enabled: false })),
        /administrator/);
    assert.throws(() => household.validate(household.withChanges(three(), 'abdullah', { admin: false })),
        /administrator/);
});

test('two people cannot claim one login, or one id', () => {
    assert.throws(
        () => household.validate(household.withPerson(three(),
            { id: 'other', displayName: 'Other', tailscaleLogin: 'FAISALC@gmail.com' })),
        /claim the login/);
    assert.throws(
        () => household.withPerson(three(), { id: 'Dad', displayName: 'Dad again', tailscaleLogin: 'x@y.z' }),
        /already someone/);
});

test('removing somebody takes their contacts and group membership with them', () => {
    const next = household.validate(household.withoutPerson(three(), 'dad'));
    assert.deepEqual(next.users.map((user) => user.id), ['abdullah', 'mum']);
    assert.deepEqual(next.contacts, [], 'a contact of somebody gone is a reference to nobody');
    assert.deepEqual(next.groups[0].memberIds, ['abdullah', 'mum']);
});

test('writing replaces the file in one move, and keeps the version before it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-household-'));
    const file = path.join(dir, 'family.json');
    household.write(file, three());
    household.write(file, household.withoutPerson(three(), 'dad'));

    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).users.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(household.backupPath(file), 'utf8')).users.length, 3);
    assert.equal(fs.existsSync(`${file}.writing`), false, 'nothing is left half-written');
});
