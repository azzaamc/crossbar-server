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
  relationship TEXT NOT NULL DEFAULT '',
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

class Store {
    constructor(dataDir, familyConfigPath) {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path.join(dataDir, 'crossbar.sqlite'));
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
        this.db.exec(SCHEMA);
        this.syncFamilyConfig(familyConfigPath);
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
            const upsert = this.db.prepare(`
                INSERT INTO users (id, tailscale_login, display_name, relationship, avatar)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET tailscale_login=excluded.tailscale_login,
                  display_name=CASE WHEN users.first_seen_at IS NULL THEN excluded.display_name ELSE users.display_name END,
                  relationship=excluded.relationship,
                  avatar=CASE WHEN users.first_seen_at IS NULL THEN excluded.avatar ELSE users.avatar END,
                  enabled=1
            `);
            for (const user of users) {
                assertId(user.id, 'user id');
                const login = String(user.tailscaleLogin || '').trim().toLowerCase();
                if (!login) throw new Error(`Missing tailscale login for ${user.id}`);
                upsert.run(
                    user.id,
                    login,
                    cleanText(user.displayName, 80, 'display name'),
                    cleanOptional(user.relationship, 80),
                    cleanOptional(user.avatar, 500),
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
            SELECT id, display_name AS displayName, relationship, avatar,
              first_seen_at AS firstSeen, last_authenticated_at AS lastAuthenticated
            FROM users WHERE tailscale_login = ? COLLATE NOCASE AND enabled = 1
        `).get(login) || null;
    }

    userById(id) {
        return this.db.prepare(`
            SELECT id, display_name AS displayName, relationship, avatar,
              first_seen_at AS firstSeen, last_authenticated_at AS lastAuthenticated
            FROM users WHERE id = ? AND enabled = 1
        `).get(id) || null;
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
                      (id, tailscale_login, display_name, relationship, avatar, enabled,
                       first_seen_at, last_authenticated_at, identity_source)
                    VALUES (?, ?, ?, '', ?, 1, ?, ?, ?)
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

    contactsFor(userId) {
        return this.db.prepare(`
            SELECT u.id, u.display_name AS displayName, u.relationship, u.avatar,
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

    // ── Calls ───────────────────────────────────────────────────────────────────

    createCall({ id, roomId, callerId, deviceId, inviteeIds, kind = 'video', now }) {
        this.transaction(() => {
            this.db.prepare(`
                INSERT INTO calls (id, room_id, caller_user_id, status, kind, created_at)
                VALUES (?, ?, ?, 'ringing', ?, ?)
            `).run(id, roomId, callerId, kind, now);
            const insert = this.db.prepare(`
                INSERT INTO call_participants
                  (call_id, user_id, invited_by_user_id, status, invited_at, responded_at, joined_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            insert.run(id, callerId, callerId, 'accepted', now, now, now);
            for (const inviteeId of inviteeIds) insert.run(id, inviteeId, callerId, 'invited', now, null, null);
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

            this.db.prepare(`
                UPDATE calls SET status = ?, answered_at = COALESCE(answered_at, ?)
                WHERE id = ? AND status = 'ringing'
            `).run(machine.statusAfterAccept(call), now, callId);

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
