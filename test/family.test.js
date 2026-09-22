'use strict';

// The household file is re-applied on every start, so it has to accept anything a
// household might legitimately write into it — including moving a login from one
// person to another. That is an edit, not a corruption, and it used to prevent the
// server from starting at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/db');

const ABDULLAH = { id: 'abdullah', tailscaleLogin: 'one@dev', displayName: 'Abdullah' };
const DAD = { id: 'dad', tailscaleLogin: 'two@dev', displayName: 'Dad' };

function familyFile(dir, name, users) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ users, contacts: [], groups: [] }));
    return file;
}

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-family-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('a login may move from one person to another', (t) => {
    const dir = scratch(t);
    const before = new Store(dir, familyFile(dir, 'before.json', [ABDULLAH, DAD]));
    before.close();

    // The same two people with their logins swapped. Starting on this used to fail with
    // a UNIQUE constraint, because the first person's new login was still held by the
    // second at the moment it was applied.
    const after = new Store(dir, familyFile(dir, 'after.json', [
        { ...ABDULLAH, tailscaleLogin: 'two@dev' },
        { ...DAD, tailscaleLogin: 'one@dev' },
    ]));
    t.after(() => after.close());

    assert.equal(after.userByLogin('two@dev').id, 'abdullah');
    assert.equal(after.userByLogin('one@dev').id, 'dad');
});

test('a login taken from someone no longer in the file stops naming them', (t) => {
    const dir = scratch(t);
    const before = new Store(dir, familyFile(dir, 'before.json', [ABDULLAH, DAD]));
    before.close();

    const after = new Store(dir, familyFile(dir, 'after.json', [{ ...ABDULLAH, tailscaleLogin: 'two@dev' }]));
    t.after(() => after.close());

    assert.equal(after.userByLogin('two@dev').id, 'abdullah');
    // The person the login was taken from keeps their row — and their devices — but the
    // login no longer signs anybody in, which is what the file now says.
    assert.equal(after.userByLogin('one@dev'), null);
});

test('the same login twice in one file is refused rather than guessed at', (t) => {
    const dir = scratch(t);
    assert.throws(
        () => new Store(dir, familyFile(dir, 'clash.json', [ABDULLAH, { ...DAD, tailscaleLogin: 'one@dev' }])),
        /UNIQUE/,
    );
});

test('a household whose people have no logins is accepted where logins are not identity', (t) => {
    const dir = scratch(t);
    const file = familyFile(dir, 'notailnet.json', [
        { id: 'sara', displayName: 'Sara', admin: true },
        { id: 'omar', displayName: 'Omar' },
    ]);

    // The strict reading is the default, and it is what a server that finds people by
    // their login has to insist on.
    assert.throws(() => new Store(dir, file), /Missing tailscale login/);

    const store = new Store(dir, file, { requireLogins: false });
    t.after(() => store.close());

    assert.equal(store.listUsers().length, 2);
    assert.equal(store.userByLogin('sara'), null, 'nobody is found by a login they do not have');
    // Absent, not empty: SQLite treats NULLs as distinct in a unique index, which is the
    // whole reason two people can go without one.
    assert.deepEqual(store.listUsers().map((user) => user.login), [null, null]);
});
