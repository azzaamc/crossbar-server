'use strict';

// Backups: the database and the directory file, kept somewhere a bad start cannot reach.
//
// Exactly two things in this deployment cannot be reconstructed. The database is the only
// record of who called whom; the directory file is the only thing a person typed. Everything
// else — the units, the Caddyfile, `.env` — is in the repository or written by
// `node src/admin.js`, so a restore is these two files and nothing else. That is why this is a
// module with a timer rather than a paragraph in a runbook.
//
// The database is copied with SQLite's own `VACUUM INTO` rather than with a file copy. This
// database runs in WAL mode, where the newest transactions live in `crossbar.sqlite-wal` until
// a checkpoint, so copying the `.sqlite` file alone can silently capture a database several
// transactions old — and a backup nobody can tell is stale is worse than one that is missing.
// `VACUUM INTO` reads through the WAL and writes one consistent file.
//
// This module is also the only place that knows where backups live and what they are called,
// so the pre-migration snapshot `src/db.js` takes and the scheduled backup agree on the layout.
// Each prunes only the names it wrote: a deployment may keep a copy of its own in
// `data/backups`, and a backup routine that deletes files it did not create is one nobody can
// leave running.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const BACKUP_DIRECTORY = 'backups';
const DATABASE_NAME = 'crossbar.sqlite';
const PRE_MIGRATION_KEEP = 5;
const BACKUP_KEEP = 14;

/**
 * A UTC stamp that sorts as it reads: fixed width, so the newest name is the last one in a
 * sorted list, and `-` instead of `:` so the name survives every filesystem a backup might be
 * copied to.
 */
function utcStamp(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}

// 2026-09-26T09-41-02-123Z
const STAMP = '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z';

/** What a scheduled backup's directory is called. Only names matching this are pruned. */
const BACKUP_NAME = new RegExp(`^${STAMP}$`);

/** What a pre-migration snapshot is called — a file, beside the backup directories. */
const PRE_MIGRATION_NAME = new RegExp(`^crossbar-before-v[0-9]+-${STAMP}\\.sqlite$`);

/**
 * One consistent copy of a live database, narrowed to the owner.
 *
 * `VACUUM INTO` creates the file with the process umask, and this one holds every login in the
 * house, so a deployment whose umask is not already 0077 would leave it readable by anyone with
 * the box. The copy is chmodded rather than staged behind one like `.env` and the directory
 * file: SQLite refuses to write a file that already exists, so there is nothing to rename.
 */
function copyDatabase(sourcePath, targetPath) {
    // `new DatabaseSync` creates a database where none exists, so a missing source would
    // otherwise "succeed" as a backup of nothing.
    if (!fs.existsSync(sourcePath)) throw new Error(`there is no database at ${sourcePath}`);
    const db = new DatabaseSync(sourcePath);
    try {
        // A read-write connection, the same as the server's own. `VACUUM INTO` reads the
        // database it copies and writes only the new file, and a connection allowed to write is
        // what lets SQLite finish whatever recovery the WAL was left needing rather than making
        // the copy depend on no recovery being needed.
        //
        // The server holds this database open, and a checkpoint or a write may be in flight
        // when the timer fires. A copy that fails the instant it meets one is a backup that
        // never happens on a busy box.
        db.exec('PRAGMA busy_timeout=5000');
        db.prepare('VACUUM INTO ?').run(targetPath);
    } catch (error) {
        throw new Error(`could not copy ${sourcePath} to ${targetPath}: ${error.message}`);
    } finally {
        db.close();
    }
    fs.chmodSync(targetPath, 0o600);
    return targetPath;
}

/** The backups directory, made if it is not there. 0700: the copies inside are the household. */
function ensureBackupDirectory(dataDir) {
    const directory = path.join(dataDir, BACKUP_DIRECTORY);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
}

/**
 * Keep the newest `keep` entries whose names this module wrote, and nothing else.
 *
 * Sorting is by name rather than by mtime: the stamp is the moment the copy was taken, and a
 * backup copied onto this box from somewhere else would otherwise be pruned or spared by when
 * it was copied rather than by how old it is.
 */
function prune(parent, pattern, keep) {
    const names = fs.readdirSync(parent, { withFileTypes: true })
        .filter((entry) => (entry.isDirectory() || entry.isFile()) && pattern.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse();

    const pruned = [];
    for (const name of names.slice(keep)) {
        fs.rmSync(path.join(parent, name), { recursive: true, force: true });
        pruned.push(name);
    }
    return pruned;
}

/**
 * The snapshot `Store` takes before it applies migrations.
 *
 * `version` is the migration version the database is about to be moved to, so the name says
 * which migration the copy is a way back from. Whether a copy is needed at all is the caller's
 * question -- it knows the database's current version and whether it has any tables. Returns
 * the path, or throws; the caller refuses the start rather than migrating without it.
 */
function snapshotBeforeMigration({ dataDir, databasePath, version, keep = PRE_MIGRATION_KEEP }) {
    const backups = ensureBackupDirectory(dataDir);
    const target = path.join(backups, `crossbar-before-v${version}-${utcStamp()}.sqlite`);
    try {
        copyDatabase(databasePath, target);
    } catch (error) {
        // A half-written database with a backup's name is worse than no file: the prune counts
        // it, and on the morning somebody needs one they have no way to tell it from a copy
        // that worked until they open it. `VACUUM INTO` builds the file where it is told, so
        // whatever it managed to write goes before the error does.
        fs.rmSync(target, { force: true });
        throw error;
    }
    prune(backups, PRE_MIGRATION_NAME, keep);
    return target;
}

/**
 * One backup: the database and the directory file, under a directory named for the moment.
 *
 * A run that fails leaves nothing behind. A directory holding the database copy but not the
 * directory file would look like a backup to the next prune and to whoever is looking for one
 * on the worst day of the year, so the whole directory goes and the error reaches the caller.
 */
function runBackup({ dataDir, directoryPath, keep = BACKUP_KEEP }) {
    if (!Number.isInteger(keep) || keep < 1) {
        throw new Error(`keep must be a positive number of backups, not ${keep}`);
    }
    const source = path.join(dataDir, DATABASE_NAME);
    const backups = ensureBackupDirectory(dataDir);
    const stamp = utcStamp();
    const target = path.join(backups, stamp);
    if (fs.existsSync(target)) throw new Error(`a backup for ${stamp} is already there`);
    fs.mkdirSync(target, { mode: 0o700 });

    let databaseBytes;
    let directoryBytes;
    try {
        databaseBytes = fs.statSync(copyDatabase(source, path.join(target, DATABASE_NAME))).size;
        if (!fs.existsSync(directoryPath)) throw new Error(`there is no directory file at ${directoryPath}`);
        // Written rather than copied: `copyFileSync` gives the new file the umask's permissions,
        // not the source's, and this file holds a login for every person in the house.
        const directoryBody = fs.readFileSync(directoryPath);
        fs.writeFileSync(path.join(target, path.basename(directoryPath)), directoryBody, { mode: 0o600 });
        directoryBytes = directoryBody.length;
    } catch (error) {
        fs.rmSync(target, { recursive: true, force: true });
        throw error;
    }

    const pruned = prune(backups, BACKUP_NAME, keep);
    return { path: target, stamp, databaseBytes, directoryBytes, pruned };
}

// ── Running from a timer ────────────────────────────────────────────────────────
//
// The unit passes nothing: the paths a backup uses are the paths the server uses, read from the
// same `.env` by the same `src/config.js`, so there is one answer to "where does this deployment
// keep its data". One line on stdout, in the logger's shape, because that is what the journal
// is read with; a failed run says why and exits non-zero so the unit is marked failed.

if (require.main === module) {
    const { createLogger } = require('./log');
    const log = createLogger();
    try {
        const { loadConfig } = require('./config');
        const config = loadConfig();
        const summary = runBackup({
            dataDir: config.dataDir,
            directoryPath: config.directoryConfigPath,
        });
        log.info('backup.complete', {
            path: summary.path,
            databaseBytes: summary.databaseBytes,
            directoryBytes: summary.directoryBytes,
            pruned: summary.pruned,
        });
    } catch (error) {
        log.error('backup.failed', { error: error.message });
        process.exitCode = 1;
    }
}

module.exports = { runBackup, snapshotBeforeMigration, utcStamp };
