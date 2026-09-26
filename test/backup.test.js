'use strict';

// The two things in this deployment that a person would miss: the database, which is the only
// record of who called whom, and the directory file, which is the only thing anybody typed.
//
// These tests defend what a restore depends on -- that a copy exists *before* a migration
// touches the database, that a copy which cannot be written stops the start rather than being
// skipped, that the copy opens and holds the rows including the ones still in the WAL, and
// that pruning never reaches past the names the backup module itself wrote.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { DatabaseSync } = require('node:sqlite');

const { Store } = require('../src/db');
const { runBackup, utcStamp } = require('../src/backup');

const PEOPLE = [
    { id: 'dad', tailscaleLogin: 'dad@dev', displayName: 'Dad', admin: true },
    { id: 'abdullah', tailscaleLogin: 'abdullah@dev', displayName: 'Abdullah' },
];

const RELAY = path.join(__dirname, '..', 'src', 'backup.js');
const DAY = 24 * 60 * 60 * 1000;
const STAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z`;

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-backup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** A directory file in the shape `src/directory.js` accepts, and its path. */
function directoryFile(dir, users = PEOPLE) {
    const file = path.join(dir, 'directory.json');
    fs.writeFileSync(file, JSON.stringify({ users, contacts: [], groups: [] }, null, 2));
    return file;
}

/** An existing deployment, at the newest schema, with the server not running. */
function deployed(dir) {
    const file = directoryFile(dir);
    new Store(dir, file).close();
    return file;
}

/** Puts the database back to a version whose migration has not run yet. */
function downgrade(dir, version) {
    const db = new DatabaseSync(path.join(dir, 'crossbar.sqlite'));
    db.exec(`PRAGMA user_version = ${version}`);
    db.close();
}

const list = (dir) => fs.readdirSync(path.join(dir, 'backups')).sort();
const snapshots = (dir) => list(dir).filter((name) => /^crossbar-before-v\d+-.*\.sqlite$/.test(name));
const mode = (file) => fs.statSync(file).mode & 0o777;

test('a database is snapshotted before the migrations that change it', (t) => {
    const dir = scratch(t);
    const file = deployed(dir);
    downgrade(dir, 5);

    // A person who exists nowhere else, so the copy has something in it to check rather than
    // only a version number.
    const before = new DatabaseSync(path.join(dir, 'crossbar.sqlite'));
    before.exec("INSERT INTO users (id, display_name) VALUES ('old', 'Old')");
    before.close();

    const store = new Store(dir, file);
    t.after(() => store.close());

    const snapshotPath = path.join(dir, 'backups', snapshots(dir)[0]);
    assert.equal(snapshots(dir).length, 1, 'one copy, taken once');
    assert.match(path.basename(snapshotPath), new RegExp(`^crossbar-before-v\\d+-${STAMP}\\.sqlite$`));
    assert.equal(mode(snapshotPath), 0o600, 'the copy of every login is not readable by anyone else');

    const snapshot = new DatabaseSync(snapshotPath);
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 5,
        'the copy is from before the migration, not after');
    assert.equal(snapshot.prepare("SELECT display_name FROM users WHERE id = 'old'").get().display_name,
        'Old', 'the copy holds the rows the migration was about to be trusted with');
    snapshot.close();

    const live = new DatabaseSync(path.join(dir, 'crossbar.sqlite'));
    assert.ok(live.prepare('PRAGMA user_version').get().user_version > 5, 'and the migration did run');
    live.close();
});

test('a database this server is about to create carries no snapshot', (t) => {
    const dir = scratch(t);
    const store = new Store(dir, directoryFile(dir));
    t.after(() => store.close());

    // A fresh install has no rows to lose; a copy of an empty database is not a backup, and one
    // sitting in `data/backups` looks exactly like one that is.
    assert.equal(fs.existsSync(path.join(dir, 'backups')), false);
});

test('a snapshot that cannot be written stops the start rather than migrating without one', (t) => {
    const dir = scratch(t);
    const file = deployed(dir);
    downgrade(dir, 5);

    // A backups directory that cannot be written to is the shape of a full disk or a
    // permission mistake, and neither is a reason to migrate anyway.
    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups, { mode: 0o500 });

    assert.throws(() => new Store(dir, file), new RegExp(
        `Refusing to migrate to v\\d+ without a snapshot: could not copy .*crossbar\\.sqlite to `
        + `.*${path.sep}backups${path.sep}crossbar-before-v\\d+-${STAMP}\\.sqlite: .+`,
    ));

    const live = new DatabaseSync(path.join(dir, 'crossbar.sqlite'));
    assert.equal(live.prepare('PRAGMA user_version').get().user_version, 5,
        'nothing was applied, so the database is exactly where it was');
    live.close();
    assert.deepEqual(snapshots(dir), [], 'and no half-written copy is left wearing a backup name');
});

test('only the five newest pre-migration snapshots survive the next one', (t) => {
    const dir = scratch(t);
    const file = deployed(dir);
    downgrade(dir, 5);

    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups, { mode: 0o700 });
    const older = [7, 6, 5, 4, 3, 2, 1]
        .map((days) => `crossbar-before-v6-${utcStamp(new Date(Date.now() - days * DAY))}.sqlite`);
    for (const name of older) fs.writeFileSync(path.join(backups, name), 'a name, not a database');
    // Nothing here is a pre-migration snapshot, so nothing here is the store's to delete.
    const notes = path.join(backups, 'crossbar-before-v6-notes.txt');
    fs.writeFileSync(notes, 'mine');
    const scheduled = utcStamp();
    fs.mkdirSync(path.join(backups, scheduled));

    const store = new Store(dir, file);
    t.after(() => store.close());

    // Seven names and a new snapshot: the five newest stay, which leaves the four most recent
    // fakes and the one just taken.
    assert.equal(snapshots(dir).length, 5);
    assert.equal(fs.existsSync(path.join(backups, older[0])), false, 'the oldest went');
    assert.equal(fs.existsSync(path.join(backups, older[2])), false);
    assert.equal(fs.existsSync(path.join(backups, older[3])), true, 'the fifth newest stayed');
    // Every fake has the same mtime, so which ones went is decided by the stamp in the name.
    assert.equal(fs.readFileSync(notes, 'utf8'), 'mine');
    assert.equal(fs.statSync(path.join(backups, scheduled)).isDirectory(), true);
});

test('a backup copies the database through its WAL and the directory file', (t) => {
    const dir = scratch(t);
    const file = deployed(dir);
    const store = new Store(dir, file);
    t.after(() => store.close());

    // Committed but not checkpointed: in WAL mode this row is in `crossbar.sqlite-wal`, which is
    // exactly what a plain file copy of `crossbar.sqlite` would miss.
    store.db.exec("INSERT INTO users (id, display_name) VALUES ('unflushed', 'Unflushed')");
    assert.ok(fs.statSync(path.join(dir, 'crossbar.sqlite-wal')).size > 0);

    const summary = runBackup({ dataDir: dir, directoryPath: file });

    const databaseCopy = path.join(summary.path, 'crossbar.sqlite');
    const directoryCopy = path.join(summary.path, 'directory.json');
    assert.equal(mode(databaseCopy), 0o600);
    assert.equal(mode(directoryCopy), 0o600, 'the file that holds a login for everyone');

    const copy = new DatabaseSync(databaseCopy);
    assert.equal(copy.prepare("SELECT display_name FROM users WHERE id = 'unflushed'").get().display_name,
        'Unflushed', 'the copy holds what the WAL held');
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3);
    assert.equal(copy.prepare('PRAGMA user_version').get().user_version,
        store.db.prepare('PRAGMA user_version').get().user_version);
    copy.close();

    assert.deepEqual(
        JSON.parse(fs.readFileSync(directoryCopy, 'utf8')),
        JSON.parse(fs.readFileSync(file, 'utf8')),
    );
    assert.equal(summary.databaseBytes, fs.statSync(databaseCopy).size);
    assert.deepEqual(summary.pruned, []);
});

test('a backup prunes its own older directories and nothing else', (t) => {
    const dir = scratch(t);
    const file = deployed(dir);

    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups, { mode: 0o700 });
    const older = [3, 2, 1].map((days) => utcStamp(new Date(Date.now() - days * DAY)));
    for (const name of older) fs.mkdirSync(path.join(backups, name));
    // A copy somebody made by hand before a risky change, and a note about it. A backup routine
    // that deletes what it did not write is one nobody can leave running.
    fs.mkdirSync(path.join(backups, 'before-the-migration'));
    fs.writeFileSync(path.join(backups, 'notes.txt'), 'mine');

    const summary = runBackup({ dataDir: dir, directoryPath: file, keep: 2 });

    assert.deepEqual(list(dir), [older[2], 'before-the-migration', 'notes.txt', summary.stamp].sort());
    assert.deepEqual(summary.pruned.slice().sort(), [older[0], older[1]]);
    assert.equal(fs.existsSync(path.join(summary.path, 'crossbar.sqlite')), true,
        'the run never prunes itself');
    assert.equal(fs.statSync(path.join(backups, 'before-the-migration')).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(backups, 'notes.txt'), 'utf8'), 'mine');
});

test('the module runs from a timer with no arguments and reports one line', (t) => {
    const dir = scratch(t);
    const file = deployed(dir);

    // Exactly what the unit does: no arguments, the same paths `src/config.js` gives the server.
    const run = spawnSync(process.execPath, [RELAY], {
        cwd: dir,
        env: { PATH: process.env.PATH, DATA_DIR: dir, DIRECTORY_CONFIG_PATH: file },
        encoding: 'utf8',
    });

    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split('\n');
    assert.equal(lines.length, 1, run.stdout);
    const record = JSON.parse(lines[0]);
    assert.equal(record.level, 'info');
    assert.equal(record.event, 'backup.complete');
    assert.equal(path.dirname(record.path), path.join(dir, 'backups'));
    assert.match(path.basename(record.path), new RegExp(`^${STAMP}$`));
    assert.equal(record.pruned.length, 0);
    assert.ok(record.databaseBytes > 0);
    assert.ok(record.directoryBytes > 0);
});

test('a backup that cannot complete exits non-zero and leaves no half copy', (t) => {
    const dir = scratch(t);
    deployed(dir);

    const run = spawnSync(process.execPath, [RELAY], {
        cwd: dir,
        // A directory file that is not there: the database copy succeeds and the run must still
        // fail, because a backup missing the only thing a person typed is not one.
        env: { PATH: process.env.PATH, DATA_DIR: dir, DIRECTORY_CONFIG_PATH: path.join(dir, 'gone.json') },
        encoding: 'utf8',
    });

    assert.notEqual(run.status, 0);
    const record = JSON.parse(run.stdout.trim().split('\n').pop());
    assert.equal(record.event, 'backup.failed');
    assert.match(record.error, /no directory file at/);
    assert.deepEqual(list(dir), [], 'the failed run cleaned up after itself');
});
