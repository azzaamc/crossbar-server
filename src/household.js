'use strict';

// The household file, read and written.
//
// It is the source of truth for who is in this household: the database's people are synced
// from it on every start, so editing a person means editing this file, not the rows it
// produces. Kept apart from the server so the rules about what a household may be — at least
// one person, at least one administrator, one login each — live in one place, are checked
// before anything is written, and can be tested without a server.

const fs = require('node:fs');
const path = require('node:path');

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const NAME_LIMIT = 80;

const clean = (value, limit = NAME_LIMIT) => String(value ?? '').trim().slice(0, limit);
const loginOf = (user) => clean(user.tailscaleLogin, 200).toLowerCase();

/**
 * What a household file has to be, whoever wrote it.
 *
 * Throws rather than returning, because every caller is about to write this file and a file
 * that cannot be loaded is a server that cannot start.
 */
function validate(household) {
    const users = Array.isArray(household?.users) ? household.users : [];
    if (!users.length) throw new Error('A household needs at least one person.');

    const ids = new Set();
    const logins = new Set();
    for (const user of users) {
        const id = clean(user.id);
        if (!ID_PATTERN.test(id)) throw new Error(`"${id}" is not a usable id.`);
        if (ids.has(id.toLowerCase())) throw new Error(`Two people share the id ${id}.`);
        ids.add(id.toLowerCase());

        if (!clean(user.displayName)) throw new Error(`${id} has no name.`);
        const login = loginOf(user);
        if (!login) throw new Error(`${id} has no login, and a person is found by theirs.`);
        if (logins.has(login)) throw new Error(`Two people claim the login ${login}.`);
        logins.add(login);
    }

    // A household nobody can administer is a state not worth being able to reach.
    if (!users.some((user) => user.admin && user.enabled !== false)) {
        throw new Error('A household needs an administrator who is not suspended.');
    }
    return household;
}

function read(filePath) {
    if (!fs.existsSync(filePath)) throw new Error(`No household file at ${filePath}.`);
    return validate(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

/**
 * Writes the file the way a thing that can lose power should be written: to a neighbour
 * first, then moved into place, with the previous version kept beside it. A half-written
 * household is a server that will not start.
 */
function write(filePath, household) {
    validate(household);
    const body = `${JSON.stringify(household, null, 2)}\n`;
    const staging = `${filePath}.writing`;
    fs.writeFileSync(staging, body, { mode: 0o600 });
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.previous`);
    fs.renameSync(staging, filePath);
    return household;
}

/** The file with one person added, checked but not written. */
function withPerson(household, person) {
    const id = clean(person.id).toLowerCase();
    if (household.users.some((user) => user.id.toLowerCase() === id)) {
        throw new Error(`There is already someone with the id ${id}.`);
    }
    return {
        ...household,
        users: [...household.users, {
            id,
            tailscaleLogin: loginOf(person),
            displayName: clean(person.displayName),
            avatar: clean(person.avatar, 500),
            ...(person.admin ? { admin: true } : {}),
        }].map(stripUndefined),
    };
}

/** The file with one person's fields changed, checked but not written. */
function withChanges(household, id, changes) {
    const wanted = clean(id).toLowerCase();
    if (!household.users.some((user) => user.id.toLowerCase() === wanted)) {
        throw new Error(`There is nobody with the id ${clean(id)}.`);
    }
    return {
        ...household,
        users: household.users.map((user) => {
            if (user.id.toLowerCase() !== wanted) return user;
            const next = { ...user };
            if (changes.displayName !== undefined) next.displayName = clean(changes.displayName);
            if (changes.tailscaleLogin !== undefined) next.tailscaleLogin = loginOf(changes);
            if (changes.avatar !== undefined) next.avatar = clean(changes.avatar, 500);
            if (changes.admin !== undefined) next.admin = Boolean(changes.admin);
            if (changes.enabled !== undefined) next.enabled = Boolean(changes.enabled);
            // An administrator holds the flag; anyone else simply does not have it.
            if (next.admin === false) delete next.admin;
            return stripUndefined(next);
        }),
    };
}

/** The file with one person taken out, checked but not written. */
function withoutPerson(household, id) {
    const wanted = clean(id).toLowerCase();
    const users = household.users.filter((user) => user.id.toLowerCase() !== wanted);
    if (users.length === household.users.length) throw new Error(`There is nobody with the id ${clean(id)}.`);
    return {
        ...household,
        users,
        // Their contacts and any group they were in go with them, or the next sync fails
        // on a reference to somebody who is no longer there.
        contacts: (household.contacts || []).filter((contact) => (
            String(contact.ownerId || '').toLowerCase() !== wanted
            && String(contact.contactId || '').toLowerCase() !== wanted
        )),
        groups: (household.groups || []).map((group) => ({
            ...group,
            memberIds: (group.memberIds || []).filter((member) => String(member).toLowerCase() !== wanted),
        })),
    };
}

/** A key set to undefined is a key that was never meant to be written. */
function stripUndefined(user) {
    return Object.fromEntries(Object.entries(user).filter(([, value]) => value !== undefined));
}

module.exports = {
    read,
    write,
    validate,
    withPerson,
    withChanges,
    withoutPerson,
    backupPath: (filePath) => `${filePath}.previous`,
    path: (dir) => path.resolve(dir, 'family.json'),
};
