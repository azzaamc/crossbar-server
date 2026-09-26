'use strict';

// The directory file is re-applied on every start, so it has to accept anything a
// directory might legitimately write into it — including moving a login from one
// person to another. That is an edit, not a corruption, and it used to prevent the
// server from starting at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');

const { Store } = require('../src/db');

const ABDULLAH = { id: 'abdullah', tailscaleLogin: 'one@dev', displayName: 'Abdullah' };
const DAD = { id: 'dad', tailscaleLogin: 'two@dev', displayName: 'Dad' };

function directoryFile(dir, name, users) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ users, contacts: [], groups: [] }));
    return file;
}

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-directory-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('a login may move from one person to another', (t) => {
    const dir = scratch(t);
    const before = new Store(dir, directoryFile(dir, 'before.json', [ABDULLAH, DAD]));
    before.close();

    // The same two people with their logins swapped. Starting on this used to fail with
    // a UNIQUE constraint, because the first person's new login was still held by the
    // second at the moment it was applied.
    const after = new Store(dir, directoryFile(dir, 'after.json', [
        { ...ABDULLAH, tailscaleLogin: 'two@dev' },
        { ...DAD, tailscaleLogin: 'one@dev' },
    ]));
    t.after(() => after.close());

    assert.equal(after.userByLogin('two@dev').id, 'abdullah');
    assert.equal(after.userByLogin('one@dev').id, 'dad');
});

test('a login taken from someone no longer in the file stops naming them', (t) => {
    const dir = scratch(t);
    const before = new Store(dir, directoryFile(dir, 'before.json', [ABDULLAH, DAD]));
    before.close();

    const after = new Store(dir, directoryFile(dir, 'after.json', [{ ...ABDULLAH, tailscaleLogin: 'two@dev' }]));
    t.after(() => after.close());

    assert.equal(after.userByLogin('two@dev').id, 'abdullah');
    // The person the login was taken from keeps their row — and their devices — but the
    // login no longer signs anybody in, which is what the file now says.
    assert.equal(after.userByLogin('one@dev'), null);
});

test('the same login twice in one file is refused rather than guessed at', (t) => {
    const dir = scratch(t);
    assert.throws(
        () => new Store(dir, directoryFile(dir, 'clash.json', [ABDULLAH, { ...DAD, tailscaleLogin: 'one@dev' }])),
        /UNIQUE/,
    );
});

test('a directory whose people have no logins is loaded, and finds nobody by one', (t) => {
    const dir = scratch(t);
    const file = directoryFile(dir, 'notailnet.json', [
        { id: 'sara', displayName: 'Sara', admin: true },
        { id: 'omar', displayName: 'Omar' },
    ]);

    // A directory is written down before its people's tailnet logins are known, and the
    // server must not be unable to start over that: it loads, and a person without a login
    // is never found by one -- which is exactly what stops them reaching the service.
    const store = new Store(dir, file);
    t.after(() => store.close());

    assert.equal(store.listUsers().length, 2);
    assert.equal(store.userByLogin('sara'), null, 'nobody is found by a login they do not have');
    // Absent, not empty: SQLite treats NULLs as distinct in a unique index, which is the
    // whole reason two people can go without one.
    assert.deepEqual(store.listUsers().map((user) => user.login), [null, null]);
});


test('a database written before the table was renamed keeps its groups', (t) => {
    const dir = scratch(t);
    const file = path.join(dir, 'directory.json');
    fs.writeFileSync(file, JSON.stringify({
        users: [ABDULLAH],
        contacts: [],
        groups: [{ id: 'everyone', displayName: 'Everyone', memberIds: ['abdullah'] }],
    }));

    // Build a database in the old world: everything the current schema makes, with the table
    // under its old name and the version number a database from before the rename would have.
    // The foreign key follows the rename, so group_members points at the old name too — which
    // is exactly the shape the migration has to cope with.
    const dbPath = path.join(dir, 'crossbar.sqlite');
    const before = new Store(dir, file);
    before.close();
    const old = new DatabaseSync(dbPath);
    old.exec("ALTER TABLE groups RENAME TO family_groups; PRAGMA user_version = 5;");
    old.close();

    // Starting the store again is what migrates it.
    const after = new Store(dir, file);
    after.close();

    const db = new DatabaseSync(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map((row) => row.name);
    assert.ok(tables.includes('groups'), 'the table took its new name');
    assert.ok(!tables.includes('family_groups'), 'and the old name is gone');
    assert.match(
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'group_members'").get().sql,
        /REFERENCES\s+"?groups"?\s*\(id\)/,
        'the foreign key followed the rename, so membership still joins to a group',
    );
    db.close();

    // And the rows the table is for came through the rename with it.
    const check = new DatabaseSync(dbPath);
    assert.deepEqual(
        check.prepare('SELECT id FROM groups').all().map((row) => row.id),
        ['everyone'],
    );
    assert.deepEqual(
        check.prepare('SELECT group_id, user_id FROM group_members').all()
            .map((row) => `${row.group_id}/${row.user_id}`),
        ['everyone/abdullah'],
        'membership survived, which it could not have if the foreign key had been left behind',
    );
    check.close();
});
