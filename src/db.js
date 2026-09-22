'use strict';

// Durable state, in one SQLite file.
//
// Two things this layer owns that the previous backend did not:
//   * devices — a person may be signed in on more than one, and "is this device in
//     the call" is a server fact rather than a client's private note;
//   * leaving — a participant may leave an active call without ending it, and the
//     call ends only when nobody is left in it.
//
// Every transition goes through a method here, inside a transaction, with the
// rules taken from `calls.js` rather than re-derived inline.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const machine = require('./calls');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tailscale_login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_seen_at TEXT,
  last_authenticated_at TEXT,
  identity_source TEXT NOT NULL DEFAULT 'configured'
);
CREATE TABLE IF NOT EXISTS contacts (
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  contact_user_id TEXT NOT NULL REFERENCES users(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_user_id, contact_user_id),
  CHECK (owner_user_id <> contact_user_id)
);
CREATE TABLE IF NOT EXISTS family_groups (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  push_token TEXT,
  push_environment TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE,
  caller_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'video',
  created_at TEXT NOT NULL,
  answered_at TEXT,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS call_participants (
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  invited_by_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL,
  invited_at TEXT NOT NULL,
  responded_at TEXT,
  joined_at TEXT,
  left_at TEXT,
  PRIMARY KEY (call_id, user_id)
);
CREATE TABLE IF NOT EXISTS call_devices (
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (call_id, device_id)
);
CREATE TABLE IF NOT EXISTS presence (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_status_created ON calls(status, created_at);
CREATE INDEX IF NOT EXISTS idx_participants_user_status ON call_participants(user_id, status);
CREATE INDEX IF NOT EXISTS idx_call_devices_device ON call_devices(device_id, left_at);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
`;

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function addColumnIfMissing(db, table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (columns.includes(column)) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
}

/** The other direction: a column this server no longer has a use for. */
function dropColumnIfPresent(db, table, column) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!columns.includes(column)) return false;
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    return true;
}

/**
 * Schema changes that have to land on a database which already exists.
 *
 * `SCHEMA` above is what a new install starts with; this is how an older one catches
 * up. Columns are added only when they are missing and tables are created
 * idempotently, so running this every start is safe, and `user_version` records how
 * far a database has come.
 */
const MIGRATIONS = [
    {
        version: 1,
        apply(db) {
            // A device's own key. The private half never leaves the device; this is the
            // half the server checks a challenge signature against. `status` exists so
            // revocation is a fact about a row rather than a row that disappears.
            addColumnIfMissing(db, 'devices', 'public_key', 'TEXT');
            addColumnIfMissing(db, 'devices', 'key_algorithm', "TEXT NOT NULL DEFAULT ''");
            addColumnIfMissing(db, 'devices', 'status', "TEXT NOT NULL DEFAULT 'active'");
            addColumnIfMissing(db, 'devices', 'revoked_at', 'TEXT');

            // Who may admit a device or take one away. It is a property of a person in
            // the household file, not a separate account: there is one kind of user
            // here, and some of them administer.
            addColumnIfMissing(db, 'users', 'admin', 'INTEGER NOT NULL DEFAULT 0');

            // An enrolment invitation. Only the hash is stored: a copy of the database
            // is not a stack of working invitations.
            db.exec(`
                CREATE TABLE IF NOT EXISTS enrollment_tokens (
                  id TEXT PRIMARY KEY,
                  token_hash TEXT NOT NULL UNIQUE,
                  created_at TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  used_at TEXT,
                  used_by_device_id TEXT,
                  revoked_at TEXT,
                  created_by TEXT,
                  intended_user_id TEXT REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_live
                  ON enrollment_tokens(expires_at, used_at, revoked_at);

                -- The other ways a device can be recognised. A device key is the
                -- canonical identity; everything here is additional evidence about the
                -- same device, kept apart so no single mechanism becomes the identity.
                CREATE TABLE IF NOT EXISTS authenticators (
                  id TEXT PRIMARY KEY,
                  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                  type TEXT NOT NULL,
                  external_subject TEXT NOT NULL DEFAULT '',
                  metadata TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL,
                  last_verified_at TEXT,
                  revoked_at TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_authenticators_identity
                  ON authenticators(device_id, type, external_subject);

                CREATE TABLE IF NOT EXISTS auth_challenges (
                  id TEXT PRIMARY KEY,
                  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                  nonce TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  used_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_auth_challenges_device
                  ON auth_challenges(device_id, used_at);
            `);
        },
    },
    {
        version: 2,
        apply(db) {
            // Anyone already holding an active device has arrived, whatever the old rule
            // said. Being present used to be established by `observeIdentity` — a login
            // read out of a proxy header the local reverse proxy injects — and a public
            // deployment refuses that header outright. So a server with two phones enrolled
            // in it had nobody marked as present, and showed no contacts at all. Enrolment
            // sets this now; this is the same statement, for the people who enrolled before
            // it did.
            db.exec(`
                UPDATE users
                   SET first_seen_at = COALESCE(first_seen_at, last_authenticated_at, CURRENT_TIMESTAMP)
                 WHERE enabled = 1
                   AND id IN (SELECT user_id FROM devices WHERE status = 'active')
            `);
        },
    },
    {
        version: 3,
        apply(db) {
            // `relationship` labelled a person to the household — "Father", "Me" — and it
            // turned out to carry nothing: no screen needed it, and a label a person cannot
            // change about themselves is worse than no label at all. It is gone from the
            // household file, the API and the app; this takes it off databases that already
            // have it.
            dropColumnIfPresent(db, 'users', 'relationship');
        },
    },
];

class Store {
    constructor(dataDir, familyConfigPath) {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path.join(dataDir, 'crossbar.sqlite'));
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
        this.db.exec(SCHEMA);
        this.migrate();
        this.syncFamilyConfig(familyConfigPath);
    }

    /** Applies whatever this database has not seen. Safe to run on every start. */
    migrate() {
        const current = this.db.prepare('PRAGMA user_version').get().user_version || 0;
        for (const migration of MIGRATIONS) {
            if (migration.version <= current) continue;
            this.transaction(() => {
                migration.apply(this.db);
                // The version is a literal from this file, never from a request.
                this.db.exec(`PRAGMA user_version = ${migration.version}`);
            });
        }
    }

    close() {
        this.db.close();
    }

    transaction(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    // ── Configuration ───────────────────────────────────────────────────────────

    /**
     * Users, contacts and groups come from a file the household maintains, and are
     * re-applied on every start. A user's display name and avatar are only taken
     * from the file *before* they have ever signed in: after that, what the tailnet
     * says about them wins, because that is the name their devices show.
     */
    syncFamilyConfig(filePath) {
        if (!fs.existsSync(filePath)) throw new Error(`Family configuration not found: ${filePath}`);
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const users = Array.isArray(parsed.users) ? parsed.users : [];
        if (!users.length) throw new Error('Family configuration requires at least one user');

        this.transaction(() => {
            // A login is how a tailnet identity finds its person, and only one row may
            // hold it. Moving one — correcting a mistyped login, or swapping two
            // people's — would otherwise collide with whoever holds it now, and the
            // server would refuse to start over a household file that is perfectly
            // correct. So every login the file is about to claim is released first,
            // under a value no login can be.
            const release = this.db.prepare(`
                UPDATE users SET tailscale_login = 'replaced:' || id
                WHERE tailscale_login = ? COLLATE NOCASE AND id <> ?
            `);
            for (const user of users) {
                assertId(user.id, 'user id');
                const login = String(user.tailscaleLogin || '').trim().toLowerCase();
                if (!login) throw new Error(`Missing tailscale login for ${user.id}`);
                release.run(login, user.id);
            }

            const upsert = this.db.prepare(`
                INSERT INTO users (id, tailscale_login, display_name, avatar, admin, enabled)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET tailscale_login=excluded.tailscale_login,
                  display_name=CASE WHEN users.first_seen_at IS NULL THEN excluded.display_name ELSE users.display_name END,
                  avatar=CASE WHEN users.first_seen_at IS NULL THEN excluded.avatar ELSE users.avatar END,
                  admin=excluded.admin,
                  enabled=excluded.enabled
            `);
            for (const user of users) {
                assertId(user.id, 'user id');
                const login = String(user.tailscaleLogin || '').trim().toLowerCase();
                if (!login) throw new Error(`Missing tailscale login for ${user.id}`);
                upsert.run(
                    user.id,
                    login,
                    cleanText(user.displayName, 80, 'display name'),
                    cleanOptional(user.avatar, 500),
                    user.admin ? 1 : 0,
                    // Suspending is a statement about the household, kept in the file where the
                    // household is written down: a suspended person keeps their identity, their
                    // devices and their history, and stops being able to sign in.
                    user.enabled === false ? 0 : 1,
                );
            }

            this.db.exec('DELETE FROM contacts; DELETE FROM group_members; DELETE FROM family_groups;');
            const insertContact = this.db.prepare(
                'INSERT INTO contacts (owner_user_id, contact_user_id, sort_order) VALUES (?, ?, ?)',
            );
            for (const item of parsed.contacts || []) {
                insertContact.run(item.ownerId, item.contactId, Number(item.sortOrder) || 0);
            }
            const insertGroup = this.db.prepare('INSERT INTO family_groups (id, display_name) VALUES (?, ?)');
            const insertMember = this.db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)');
            for (const group of parsed.groups || []) {
                assertId(group.id, 'group id');
                insertGroup.run(group.id, cleanText(group.displayName, 80, 'group display name'));
                for (const userId of group.memberIds || []) insertMember.run(group.id, userId);
            }
        });
    }

    // ── People ──────────────────────────────────────────────────────────────────

    userByLogin(login) {
        return this.db.prepare(`
            SELECT id, display_name AS displayName, avatar, admin,
              first_seen_at AS firstSeen, last_authenticated_at AS lastAuthenticated
            FROM users WHERE tailscale_login = ? COLLATE NOCASE AND enabled = 1
        `).get(login) || null;
    }

    userById(id) {
        return this.db.prepare(`
            SELECT id, display_name AS displayName, avatar, admin,
              first_seen_at AS firstSeen, last_authenticated_at AS lastAuthenticated
            FROM users WHERE id = ? AND enabled = 1
        `).get(id) || null;
    }

    /** Everyone the household file knows, for an operator. */
    listUsers() {
        return this.db.prepare(`
            SELECT u.id, u.display_name AS displayName, u.tailscale_login AS login,
              u.admin, u.enabled, u.first_seen_at AS firstSeen, u.last_authenticated_at AS lastAuthenticated,
              (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.status = 'active') AS activeDevices
            FROM users u ORDER BY u.display_name
        `).all().map((row) => ({ ...row, admin: Boolean(row.admin), enabled: Boolean(row.enabled) }));
    }

    /**
     * Records a trusted authentication and returns the user.
     *
     * Two ways to become a member:
     *
     * * an entry in the household file pins a person's id, name and avatar before
     *   they have ever signed in — which is what gives them a stable identity in
     *   everyone else's directory;
     * * with `autoEnrol` (the default, and what the service this replaces did), a
     *   login that arrives from the tailnet is enrolled on first sight under a
     *   derived id.
     *
     * Auto-enrolment means the tailnet is the perimeter: anyone who can reach this
     * listener has already passed Tailscale's own admission, and the alternative —
     * requiring every device's login to be written into a file first — is how a
     * household ends up with members who cannot call anybody because nobody
     * updated the file. Set `AUTO_ENROL_IDENTITIES=false` to require the file.
     */
    observeIdentity(identity, now, { autoEnrol = true } = {}) {
        const login = String(identity.login || '').trim().toLowerCase();
        if (!login) throw new Error('A login is required');
        const displayName = identityDisplayName(identity.name, login);
        const avatar = safeAvatar(identity.profilePic);

        let existing = this.userByLogin(login);
        if (!existing) {
            const row = this.db.prepare(
                'SELECT id FROM users WHERE tailscale_login = ? COLLATE NOCASE',
            ).get(login);
            if (row) existing = { id: row.id };
        }
        if (!existing && !autoEnrol) return null;

        this.transaction(() => {
            if (existing) {
                this.db.prepare(`
                    UPDATE users SET display_name = ?,
                      avatar = CASE WHEN ? <> '' THEN ? ELSE avatar END,
                      first_seen_at = COALESCE(first_seen_at, ?), last_authenticated_at = ?, identity_source = ?
                    WHERE id = ?
                `).run(displayName, avatar, avatar, now, now, identity.source || 'tailscale', existing.id);
            } else {
                const id = `ts_${crypto.createHash('sha256').update(login).digest('hex').slice(0, 24)}`;
                this.db.prepare(`
                    INSERT INTO users
                      (id, tailscale_login, display_name, avatar, enabled,
                       first_seen_at, last_authenticated_at, identity_source)
                    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
                `).run(id, login, displayName, avatar, now, now, identity.source || 'tailscale');
                existing = { id };
            }

            // Everyone who has actually signed in becomes mutually discoverable.
            this.db.prepare(`
                INSERT OR IGNORE INTO contacts (owner_user_id, contact_user_id, sort_order)
                SELECT ?, id, 0 FROM users WHERE enabled = 1 AND first_seen_at IS NOT NULL AND id <> ?
            `).run(existing.id, existing.id);
            this.db.prepare(`
                INSERT OR IGNORE INTO contacts (owner_user_id, contact_user_id, sort_order)
                SELECT id, ?, 0 FROM users WHERE enabled = 1 AND first_seen_at IS NOT NULL AND id <> ?
            `).run(existing.id, existing.id);
        });

        return this.userByLogin(login);
    }

    /**
     * Records that a person has actually arrived.
     *
     * `first_seen_at` is what every contact, group and callable list is filtered on, and
     * until now the only thing that set it was `observeIdentity` — which reads a login out
     * of a header the local proxy injected. A public deployment refuses that header
     * outright, so nobody could ever be marked present: the household read as empty and the
     * app connected to a server that knew no one. Enrolling a device is the strongest
     * evidence of arrival a server like this has, which is why that is what sets it.
     */
    markSeen(userId, now) {
        return this.db.prepare(`
            UPDATE users SET first_seen_at = COALESCE(first_seen_at, ?), last_authenticated_at = ?
            WHERE id = ?
        `).run(now, now, userId).changes;
    }

    contactsFor(userId) {
        return this.db.prepare(`
            SELECT u.id, u.display_name AS displayName, u.avatar,
              p.last_seen_at AS lastSeen
            FROM contacts c
            JOIN users u ON u.id = c.contact_user_id AND u.enabled = 1
            LEFT JOIN presence p ON p.user_id = u.id
            WHERE c.owner_user_id = ? AND u.first_seen_at IS NOT NULL
            ORDER BY CASE WHEN p.last_seen_at IS NULL THEN 1 ELSE 0 END, c.sort_order, u.display_name
        `).all(userId);
    }

    groupsFor(userId) {
        const groups = this.db.prepare(`
            SELECT g.id, g.display_name AS displayName
            FROM family_groups g JOIN group_members mine ON mine.group_id = g.id
            WHERE mine.user_id = ? ORDER BY g.display_name
        `).all(userId);
        const members = this.db.prepare(`
            SELECT gm.user_id AS id, u.display_name AS displayName, u.avatar
            FROM group_members gm JOIN users u ON u.id = gm.user_id
            WHERE gm.group_id = ? AND u.enabled = 1 AND u.first_seen_at IS NOT NULL ORDER BY u.display_name
        `);
        return groups
            .map((group) => ({ ...group, members: members.all(group.id) }))
            .filter((group) => group.members.length > 1);
    }

    groupInvitees(groupId, callerId) {
        return this.db.prepare(`
            SELECT u.id, u.display_name AS displayName
            FROM group_members gm JOIN users u ON u.id = gm.user_id AND u.enabled = 1
            WHERE gm.group_id = ? AND gm.user_id <> ? AND u.first_seen_at IS NOT NULL
        `).all(groupId, callerId);
    }

    allowedContacts(ownerId, ids) {
        if (!ids.length) return [];
        const placeholders = ids.map(() => '?').join(',');
        return this.db.prepare(`
            SELECT u.id, u.display_name AS displayName
            FROM contacts c JOIN users u ON u.id = c.contact_user_id AND u.enabled = 1
            WHERE c.owner_user_id = ? AND u.first_seen_at IS NOT NULL AND c.contact_user_id IN (${placeholders})
        `).all(ownerId, ...ids);
    }

    // ── Devices ─────────────────────────────────────────────────────────────────

    /**
     * A device identifies an install, not a person. It is what makes "this device is
     * in this call" answerable, and what a push token belongs to.
     */
    registerDevice({ userId, deviceId, label = '', platform = '', now }) {
        if (!DEVICE_ID_PATTERN.test(String(deviceId || ''))) throw new Error('Invalid device id');
        this.db.prepare(`
            INSERT INTO devices (id, user_id, label, platform, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, label=excluded.label,
              platform=excluded.platform, last_seen_at=excluded.last_seen_at
        `).run(deviceId, userId, cleanOptional(label, 60), cleanOptional(platform, 40), now, now);
        return this.deviceById(deviceId);
    }

    deviceById(deviceId) {
        return this.db.prepare(`
            SELECT id, user_id AS userId, label, platform, created_at AS createdAt, last_seen_at AS lastSeenAt
            FROM devices WHERE id = ?
        `).get(deviceId) || null;
    }

    touchDevice(deviceId, now) {
        this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, deviceId);
    }

    savePushToken({ deviceId, token, environment, now }) {
        this.db.prepare(`
            UPDATE devices SET push_token = ?, push_environment = ?, last_seen_at = ? WHERE id = ?
        `).run(cleanOptional(token, 400), cleanOptional(environment, 20) || 'production', now, deviceId);
    }

    devicesFor(userId) {
        return this.db.prepare(`
            SELECT id, label, platform, push_token AS pushToken, push_environment AS pushEnvironment,
              last_seen_at AS lastSeenAt
            FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC
        `).all(userId);
    }

    // ── Device identity ─────────────────────────────────────────────────────────

    /** A device as an identity: its key, and whether it may still use it. */
    deviceIdentity(deviceId) {
        return this.db.prepare(`
            SELECT id, user_id AS userId, label, platform, public_key AS publicKey,
              key_algorithm AS keyAlgorithm, status, created_at AS createdAt,
              last_seen_at AS lastSeenAt, revoked_at AS revokedAt
            FROM devices WHERE id = ?
        `).get(deviceId) || null;
    }

    /**
     * A device that has just proved it holds the private half of `publicKey`. The id
     * is the server's, not the client's: a device may choose its own label, but not
     * the name it is known by.
     */
    registerEnrolledDevice({ id, userId, label, platform, publicKey, algorithm, now }) {
        this.db.prepare(`
            INSERT INTO devices
              (id, user_id, label, platform, public_key, key_algorithm, status, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `).run(id, userId, cleanOptional(label, 60), cleanOptional(platform, 40),
            String(publicKey || ''), String(algorithm || ''), now, now);
        return this.deviceIdentity(id);
    }

    renameDevice(deviceId, label, now) {
        const result = this.db.prepare('UPDATE devices SET label = ?, last_seen_at = ? WHERE id = ?')
            .run(cleanOptional(label, 60), now, deviceId);
        return result.changes === 1;
    }

    /**
     * A revoked device is not a revoked person. The key stops working and the push
     * token is dropped so nothing is delivered to it, but the row stays: an iPhone
     * that was replaced is a fact worth keeping, and an audit that cannot see it is
     * not an audit.
     */
    revokeDevice(deviceId, now) {
        const result = this.db.prepare(`
            UPDATE devices SET status = 'revoked', revoked_at = ?, push_token = NULL, push_environment = NULL
            WHERE id = ? AND status <> 'revoked'
        `).run(now, deviceId);
        return result.changes === 1;
    }

    /**
     * Whether somebody may be signed in as.
     *
     * What leaving the household comes to on this side: the file stops naming them, and
     * their row stays, because calls, participants, devices and authenticators all point at
     * it and a household's history is not something to erase to tidy a list. `userById` and
     * `userByLogin` refuse a row that is not enabled, so this is the whole of it.
     */
    setUserEnabled(id, enabled) {
        const wanted = enabled ? 1 : 0;
        return this.db.prepare('UPDATE users SET enabled = ? WHERE id = ? AND enabled <> ?')
            .run(wanted, id, wanted).changes > 0;
    }

    /** Every device, for an operator. Not filtered by anything the caller claims. */
    allDevices(userId = null) {
        const where = userId ? 'WHERE d.user_id = ?' : '';
        return this.db.prepare(`
            SELECT d.id, d.user_id AS userId, u.display_name AS userName, d.label, d.platform,
              d.status, d.key_algorithm AS keyAlgorithm, (d.public_key IS NOT NULL) AS hasKey,
              (d.push_token IS NOT NULL) AS hasPushToken, d.created_at AS createdAt,
              d.last_seen_at AS lastSeenAt, d.revoked_at AS revokedAt
            FROM devices d JOIN users u ON u.id = d.user_id ${where}
            ORDER BY u.display_name, d.last_seen_at DESC
        `).all(...(userId ? [userId] : []));
    }

    // ── Enrolment invitations ───────────────────────────────────────────────────

    /** Only the hash is stored: a copy of this database is not a stack of working invitations. */
    createEnrollment({ id, tokenHash, now, expiresAt, createdBy = null, intendedUserId = null }) {
        this.db.prepare(`
            INSERT INTO enrollment_tokens
              (id, token_hash, created_at, expires_at, created_by, intended_user_id)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, tokenHash, now, expiresAt, createdBy, intendedUserId);
        return this.enrollmentById(id);
    }

    enrollmentById(id) {
        return this.db.prepare(`
            SELECT id, token_hash AS tokenHash, created_at AS createdAt, expires_at AS expiresAt,
              used_at AS usedAt, used_by_device_id AS usedByDeviceId, revoked_at AS revokedAt,
              created_by AS createdBy, intended_user_id AS intendedUserId
            FROM enrollment_tokens WHERE id = ?
        `).get(id) || null;
    }

    enrollmentByHash(tokenHash) {
        return this.db.prepare(`
            SELECT id, token_hash AS tokenHash, created_at AS createdAt, expires_at AS expiresAt,
              used_at AS usedAt, used_by_device_id AS usedByDeviceId, revoked_at AS revokedAt,
              created_by AS createdBy, intended_user_id AS intendedUserId
            FROM enrollment_tokens WHERE token_hash = ?
        `).get(tokenHash) || null;
    }

    /**
     * Spends an invitation. One statement, so two devices redeeming the same code at
     * the same moment cannot both succeed: the second finds nothing left to spend.
     */
    useEnrollment(id, deviceId, now) {
        const spent = this.db.prepare(`
            UPDATE enrollment_tokens SET used_at = ?, used_by_device_id = ?
            WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL
        `).run(now, deviceId, id);
        return spent.changes === 1;
    }

    revokeEnrollment(id, now) {
        const result = this.db.prepare(
            'UPDATE enrollment_tokens SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL',
        ).run(now, id);
        return result.changes === 1;
    }

    enrollments(now, limit = 50) {
        return this.db.prepare(`
            SELECT id, created_at AS createdAt, expires_at AS expiresAt, used_at AS usedAt,
              revoked_at AS revokedAt, created_by AS createdBy, intended_user_id AS intendedUserId,
              used_by_device_id AS usedByDeviceId,
              CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
                   WHEN used_at IS NOT NULL THEN 'used'
                   WHEN expires_at <= ? THEN 'expired'
                   ELSE 'open' END AS state
            FROM enrollment_tokens ORDER BY created_at DESC LIMIT ?
        `).all(now, Math.min(500, Math.max(1, Number(limit) || 50)));
    }

    // ── Additional authenticators ───────────────────────────────────────────────

    /**
     * Something else that vouches for the same device — the tailnet login it arrived
     * with, today. Kept in its own table so no single mechanism becomes the identity,
     * and so one can be revoked without touching the device key. A revoked
     * authenticator stays revoked: it is evidence that was withdrawn on purpose.
     */
    rememberAuthenticator({ id, deviceId, type, externalSubject = '', metadata = {}, now }) {
        this.db.prepare(`
            INSERT INTO authenticators
              (id, device_id, type, external_subject, metadata, created_at, last_verified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id, type, external_subject) DO UPDATE SET
              last_verified_at = excluded.last_verified_at,
              metadata = excluded.metadata
        `).run(id, deviceId, type, String(externalSubject || '').slice(0, 200),
            JSON.stringify(metadata || {}).slice(0, 2000), now, now);
    }

    authenticatorsForDevice(deviceId) {
        return this.db.prepare(`
            SELECT id, device_id AS deviceId, type, external_subject AS externalSubject,
              metadata, created_at AS createdAt, last_verified_at AS lastVerifiedAt,
              revoked_at AS revokedAt
            FROM authenticators WHERE device_id = ? ORDER BY created_at
        `).all(deviceId);
    }

    revokeAuthenticator(id, now) {
        const result = this.db.prepare(
            'UPDATE authenticators SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
        ).run(now, id);
        return result.changes === 1;
    }

    // ── Challenges ──────────────────────────────────────────────────────────────

    createChallenge({ id, deviceId, nonce, now, expiresAt }) {
        this.db.prepare(`
            INSERT INTO auth_challenges (id, device_id, nonce, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, deviceId, nonce, now, expiresAt);
    }

    /**
     * Takes a challenge out of circulation and hands it back. The take is what
     * decides it: two signatures arriving together cannot both be answered by the
     * same challenge, which is what makes a captured one useless to anybody else.
     */
    consumeChallenge(id, now) {
        return this.transaction(() => {
            const row = this.db.prepare('SELECT * FROM auth_challenges WHERE id = ?').get(id) || null;
            if (!row) return null;
            const taken = this.db.prepare('UPDATE auth_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL')
                .run(now, id);
            return taken.changes === 1 ? row : null;
        });
    }

    /** Challenges are cheap and worthless after minutes; only recent ones are kept. */
    purgeChallenges(now) {
        const cutoff = new Date(Date.parse(now) - 24 * 3600 * 1000).toISOString();
        const removed = this.db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(cutoff);
        return removed.changes;
    }

    // ── Calls ───────────────────────────────────────────────────────────────────

    createCall({ id, roomId, callerId, deviceId, inviteeIds, kind = 'video', status = 'ringing', now }) {
        this.transaction(() => {
            this.db.prepare(`
                INSERT INTO calls (id, room_id, caller_user_id, status, kind, created_at, answered_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(id, roomId, callerId, status, kind, now, status === 'active' ? now : null);
            const insert = this.db.prepare(`
                INSERT INTO call_participants
                  (call_id, user_id, invited_by_user_id, status, invited_at, responded_at, joined_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            insert.run(id, callerId, callerId, 'accepted', now, now, now);
            // The caller is already in the call; an invitation to themselves is not
            // a second participant.
            for (const inviteeId of inviteeIds) {
                if (inviteeId === callerId) continue;
                insert.run(id, inviteeId, callerId, 'invited', now, null, null);
            }
            if (deviceId) {
                this.db.prepare(`
                    INSERT OR REPLACE INTO call_devices (call_id, device_id, user_id, joined_at, left_at)
                    VALUES (?, ?, ?, ?, NULL)
                `).run(id, deviceId, callerId, now);
            }
        });
        return this.callById(id);
    }

    callById(id) {
        const call = this.db.prepare(`
            SELECT calls.id, calls.room_id AS roomId, calls.caller_user_id AS callerId,
              caller.display_name AS callerName, calls.status, calls.kind,
              calls.created_at AS createdAt, calls.answered_at AS answeredAt, calls.ended_at AS endedAt
            FROM calls JOIN users caller ON caller.id = calls.caller_user_id
            WHERE calls.id = ?
        `).get(id);
        if (!call) return null;
        call.participants = this.db.prepare(`
            SELECT cp.user_id AS userId, u.display_name AS displayName, u.avatar, cp.status,
              cp.invited_at AS invitedAt, cp.responded_at AS respondedAt,
              cp.joined_at AS joinedAt, cp.left_at AS leftAt
            FROM call_participants cp JOIN users u ON u.id = cp.user_id
            WHERE cp.call_id = ? ORDER BY cp.invited_at, u.display_name
        `).all(id);
        call.devices = this.db.prepare(`
            SELECT device_id AS deviceId, user_id AS userId, joined_at AS joinedAt, left_at AS leftAt
            FROM call_devices WHERE call_id = ?
        `).all(id);
        return call;
    }

    callByRoom(roomId) {
        const row = this.db.prepare('SELECT id FROM calls WHERE room_id = ?').get(roomId);
        return row ? this.callById(row.id) : null;
    }

    /** The shape clients see. `myStatus` is filled in by the routes that know whose view it is. */
    callPublic(call) {
        return {
            id: call.id,
            callerId: call.callerId,
            callerName: call.callerName,
            status: call.status,
            kind: call.kind,
            createdAt: call.createdAt,
            answeredAt: call.answeredAt ?? null,
            participants: call.participants.map((item) => ({
                userId: item.userId,
                displayName: item.displayName,
                status: item.status,
            })),
            deviceCount: call.devices.filter((item) => !item.leftAt).length,
        };
    }

    /** Open calls for the person: what they must ring, and what they are already in. */
    callsForUser(userId) {
        return this.db.prepare(`
            SELECT c.id, c.room_id AS roomId, c.caller_user_id AS callerId, caller.display_name AS callerName,
              c.status, c.kind, c.created_at AS createdAt, c.answered_at AS answeredAt,
              cp.status AS myStatus
            FROM call_participants cp
            JOIN calls c ON c.id = cp.call_id
            JOIN users caller ON caller.id = c.caller_user_id
            WHERE cp.user_id = ? AND c.status IN ('ringing', 'active')
            ORDER BY c.created_at DESC
        `).all(userId);
    }

    /** Active calls this specific device is already in. */
    ongoingCallsForDevice(deviceId) {
        return this.db.prepare(`
            SELECT c.id FROM calls c
            JOIN call_devices cd ON cd.call_id = c.id
            WHERE cd.device_id = ? AND cd.left_at IS NULL AND c.status = 'active'
            ORDER BY c.created_at DESC
        `).all(deviceId).map(({ id }) => this.callById(id));
    }

    ongoingCallsForUser(userId) {
        return this.db.prepare(`
            SELECT c.id FROM calls c
            JOIN call_participants cp ON cp.call_id = c.id
            WHERE cp.user_id = ? AND cp.status = 'accepted' AND c.status = 'active'
            ORDER BY c.created_at DESC
        `).all(userId).map(({ id }) => this.callById(id));
    }

    participant(callId, userId) {
        return this.db.prepare(
            'SELECT * FROM call_participants WHERE call_id = ? AND user_id = ?',
        ).get(callId, userId) || null;
    }

    /**
     * Answering an invitation. Returns false when the invitation was already used,
     * which is what keeps an answer from being replayed.
     */
    respond(callId, userId, response, now) {
        if (!['accepted', 'declined'].includes(response)) throw new Error('Invalid call response');
        return this.transaction(() => {
            const call = this.callById(callId);
            if (!call) return { ok: false, reason: 'CALL_NOT_FOUND' };
            const row = this.participant(callId, userId);
            if (!machine.canRespond(row)) return { ok: false, reason: 'ALREADY_RESPONDED' };

            this.db.prepare(`
                UPDATE call_participants SET status = ?, responded_at = ?,
                  joined_at = CASE WHEN ? = 'accepted' THEN ? ELSE joined_at END
                WHERE call_id = ? AND user_id = ? AND status = 'invited'
            `).run(response, now, response, now, callId, userId);

            if (response === 'accepted') {
                this.db.prepare(`
                    UPDATE calls SET status = ?, answered_at = COALESCE(answered_at, ?)
                    WHERE id = ? AND status = 'ringing'
                `).run(machine.statusAfterAccept(call), now, callId);
            } else {
                const after = this.callById(callId);
                this.db.prepare('UPDATE calls SET status = ?, ended_at = ? WHERE id = ? AND status = ?')
                    .run(machine.statusAfterDecline(after, after.participants), now, callId, 'ringing');
            }
            return { ok: true, call: this.callById(callId) };
        });
    }

    addInvitees(callId, inviterId, inviteeIds, now) {
        return this.transaction(() => {
            const call = this.callById(callId);
            if (!machine.canInvite(call, this.participant(callId, inviterId))) {
                return { ok: false, reason: 'CALL_NOT_JOINABLE' };
            }
            const insert = this.db.prepare(`
                INSERT OR IGNORE INTO call_participants
                  (call_id, user_id, invited_by_user_id, status, invited_at)
                VALUES (?, ?, ?, 'invited', ?)
            `);
            const added = inviteeIds.filter((id) => insert.run(callId, id, inviterId, now).changes > 0);
            return { ok: true, added, call: this.callById(callId) };
        });
    }

    /**
     * Admits a person, and — when the client says which device it is — that device,
     * to a call. `joined_at` is written once, because the first join is the fact
     * that matters; later re-attaches only refresh the device row.
     *
     * A join does not answer the call. The caller is a participant with `accepted`
     * from the moment the call exists, so treating a join as an answer marked every
     * outgoing call active — and stamped `answered_at` — the instant the person who
     * placed it reached the room, with nobody at the other end. The caller was then
     * told the call had connected while it was still ringing. Answering is `respond`;
     * only `respond` makes a ringing call active.
     */
    joinCall(callId, userId, deviceId, now) {
        return this.transaction(() => {
            const call = this.callById(callId);
            const row = call ? this.participant(callId, userId) : null;
            const refusal = machine.joinRefusal(call, row);
            if (refusal) return { ok: false, reason: refusal };

            this.db.prepare(`
                UPDATE call_participants
                SET status = 'accepted', responded_at = COALESCE(responded_at, ?),
                  joined_at = COALESCE(joined_at, ?), left_at = NULL
                WHERE call_id = ? AND user_id = ?
            `).run(now, now, callId, userId);

            if (deviceId) {
                this.db.prepare(`
                    INSERT INTO call_devices (call_id, device_id, user_id, joined_at, left_at)
                    VALUES (?, ?, ?, ?, NULL)
                    ON CONFLICT(call_id, device_id) DO UPDATE SET joined_at=excluded.joined_at, left_at=NULL
                `).run(callId, deviceId, userId, now);
            }

            return { ok: true, call: this.callById(callId) };
        });
    }

    /**
     * One device leaves. The person leaves only when none of their devices is still
     * in the call, and the call ends only when nobody is left in it.
     */
    leaveCall(callId, userId, deviceId, now) {
        return this.transaction(() => {
            const call = this.callById(callId);
            if (!call) return { ok: false, reason: 'CALL_NOT_FOUND' };
            if (!this.participant(callId, userId)) return { ok: false, reason: 'NOT_A_PARTICIPANT' };

            if (deviceId) {
                this.db.prepare(`
                    UPDATE call_devices SET left_at = ? WHERE call_id = ? AND device_id = ? AND left_at IS NULL
                `).run(now, callId, deviceId);
            }

            const remainingDevices = this.db.prepare(`
                SELECT COUNT(*) AS count FROM call_devices
                WHERE call_id = ? AND user_id = ? AND left_at IS NULL
            `).get(callId, userId).count;
            const deviceAware = deviceId && call.devices.some((item) => item.deviceId === deviceId);

            if (!deviceAware || remainingDevices === 0) {
                this.db.prepare(`
                    UPDATE call_participants SET status = 'left', left_at = ?
                    WHERE call_id = ? AND user_id = ? AND status = 'accepted'
                `).run(now, callId, userId);
            }

            let updated = this.callById(callId);
            let ended = false;
            if (machine.isLive(updated.status) && machine.shouldEndAfterLeave(updated.participants)) {
                this.db.prepare('UPDATE calls SET status = ?, ended_at = ? WHERE id = ?')
                    .run(machine.statusAfterEnd(updated), now, callId);
                this.db.prepare(`
                    UPDATE call_participants SET status = 'cancelled', responded_at = ?
                    WHERE call_id = ? AND status = 'invited'
                `).run(now, callId);
                ended = true;
                updated = this.callById(callId);
            }
            return { ok: true, call: updated, ended };
        });
    }

    /** Call-wide end. Any participant may end the call for everyone. */
    endCall(callId, userId, now) {
        return this.transaction(() => {
            const call = this.callById(callId);
            if (!call) return { ok: false, reason: 'CALL_NOT_FOUND' };
            if (!this.participant(callId, userId)) return { ok: false, reason: 'NOT_A_PARTICIPANT' };
            if (!machine.isLive(call.status)) return { ok: true, call };

            this.db.prepare('UPDATE calls SET status = ?, ended_at = ? WHERE id = ?')
                .run(machine.statusAfterEnd(call), now, callId);
            this.db.prepare(`
                UPDATE call_participants
                SET status = CASE WHEN status = 'invited' THEN 'cancelled' ELSE 'left' END,
                  responded_at = CASE WHEN status = 'invited' THEN ? ELSE responded_at END,
                  left_at = COALESCE(left_at, ?)
                WHERE call_id = ? AND status IN ('invited', 'accepted')
            `).run(now, now, callId);
            this.db.prepare('UPDATE call_devices SET left_at = ? WHERE call_id = ? AND left_at IS NULL')
                .run(now, callId);
            return { ok: true, call: this.callById(callId) };
        });
    }

    /** Rings expire on their own; nobody has to be connected for that to happen. */
    expireCalls(cutoff, now) {
        const ids = this.db.prepare(
            "SELECT id FROM calls WHERE status = 'ringing' AND created_at < ?",
        ).all(cutoff).map((row) => row.id);
        if (!ids.length) return ids;
        this.transaction(() => {
            const expire = this.db.prepare(
                "UPDATE calls SET status = 'missed', ended_at = ? WHERE id = ? AND status = 'ringing'",
            );
            const expireParticipant = this.db.prepare(
                "UPDATE call_participants SET status = 'missed', responded_at = ? WHERE call_id = ? AND status = 'invited'",
            );
            for (const id of ids) {
                expire.run(now, id);
                expireParticipant.run(now, id);
            }
        });
        return ids;
    }

    // ── Presence and push ───────────────────────────────────────────────────────

    touchPresence(userId, now) {
        this.db.prepare(`
            INSERT INTO presence (user_id, last_seen_at) VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
        `).run(userId, now);
    }

    savePushSubscription(userId, subscription, now) {
        const item = cleanPushSubscription(subscription);
        const id = crypto.createHash('sha256').update(item.endpoint).digest('hex');
        this.db.prepare(`
            INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, expiration_time, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh,
              auth=excluded.auth, expiration_time=excluded.expiration_time, updated_at=excluded.updated_at
        `).run(id, userId, item.endpoint, item.keys.p256dh, item.keys.auth, item.expirationTime, now, now);
        return id;
    }

    deletePushSubscription(userId, endpoint) {
        return this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
            .run(userId, endpoint).changes > 0;
    }

    deletePushEndpoint(endpoint) {
        return this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0;
    }

    pushSubscriptionsFor(userIds) {
        if (!userIds.length) return [];
        const placeholders = userIds.map(() => '?').join(',');
        return this.db.prepare(`
            SELECT user_id AS userId, endpoint, p256dh, auth, expiration_time AS expirationTime
            FROM push_subscriptions WHERE user_id IN (${placeholders})
        `).all(...userIds).map((row) => ({
            userId: row.userId,
            endpoint: row.endpoint,
            expirationTime: row.expirationTime,
            keys: { p256dh: row.p256dh, auth: row.auth },
        }));
    }
}

// ── Validation helpers ──────────────────────────────────────────────────────────

function assertId(value, label) {
    if (!ID_PATTERN.test(String(value || ''))) throw new Error(`Invalid ${label}`);
}

function cleanText(value, max, label) {
    const result = String(value || '').trim();
    if (!result || result.length > max) throw new Error(`Invalid ${label}`);
    return result;
}

function cleanOptional(value, max) {
    return String(value ?? '').trim().slice(0, max);
}

/** A display name from the tailnet, or one derived from the login if it sends none. */
function identityDisplayName(name, login) {
    const trusted = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
    if (trusted) return trusted;
    const localPart = login.split('@')[0].replace(/[._-]+/g, ' ').trim();
    if (!localPart) return 'Family member';
    return localPart.replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase()).slice(0, 80);
}

function safeAvatar(value) {
    try {
        const url = new URL(String(value || ''));
        return url.protocol === 'https:' ? url.href.slice(0, 500) : '';
    } catch {
        return '';
    }
}

function isLocalPushHost(hostname) {
    const value = hostname.toLowerCase();
    return value === 'localhost' || value.endsWith('.local') || value.endsWith('.ts.net')
        || /^[0-9.]+$/.test(value) || value.includes(':');
}

function cleanPushSubscription(subscription) {
    const endpoint = String(subscription?.endpoint || '').trim();
    let url;
    try {
        url = new URL(endpoint);
    } catch {
        throw new Error('Invalid push subscription endpoint');
    }
    if (url.protocol !== 'https:' || endpoint.length > 4096 || isLocalPushHost(url.hostname)) {
        throw new Error('Invalid push subscription endpoint');
    }
    const p256dh = String(subscription?.keys?.p256dh || '');
    const auth = String(subscription?.keys?.auth || '');
    if (!/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,100}$/.test(auth)) {
        throw new Error('Invalid push subscription keys');
    }
    const expiration = subscription?.expirationTime;
    const expirationTime = expiration == null ? null : Number(expiration);
    if (expirationTime !== null && (!Number.isSafeInteger(expirationTime) || expirationTime < 0)) {
        throw new Error('Invalid push subscription expiration');
    }
    return { endpoint, expirationTime, keys: { p256dh, auth } };
}

module.exports = {
    Store,
    DEVICE_ID_PATTERN,
    identityDisplayName,
    safeAvatar,
    cleanPushSubscription,
    cleanOptional,
};
