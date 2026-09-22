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
 * `requireLogins` is the one rule that depends on how a deployment is reached rather than
 * on what a household is: where a tailnet proxy names the caller, a login is how somebody
 * is found and everybody needs one. Where a device proves itself with a key, a login is a
 * record of who somebody is elsewhere, and a household whose people have no tailnet has
 * none to write down. It defaults to the strict reading so that a caller who has not
 * thought about it gets the rule that cannot leave somebody unreachable.
 *
 * Throws rather than returning, because every caller is about to write this file and a file
 * that cannot be loaded is a server that cannot start.
 */
function validate(household, { requireLogins = true } = {}) {
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
        if (!login && requireLogins) {
            throw new Error(`${id} has no login, and a person is found by theirs here.`);
        }
        // A login that exists is claimed by one person only, whichever reading applies.
        if (login) {
            if (logins.has(login)) throw new Error(`Two people claim the login ${login}.`);
            logins.add(login);
        }
    }

    // A contact is a pair of people in this file, so both ends have to be here. A
    // reference to somebody who is not is a row the database cannot hold, and it used to
    // fail at the next start rather than at the edit that made it.
    for (const contact of Array.isArray(household?.contacts) ? household.contacts : []) {
        const owner = clean(contact?.ownerId).toLowerCase();
        const other = clean(contact?.contactId).toLowerCase();
        if (!ids.has(owner) || !ids.has(other)) {
            throw new Error(`A contact names somebody who is not in the household: ${owner} → ${other}.`);
        }
        if (owner === other) throw new Error(`${owner} cannot be their own contact.`);
    }

    // A household nobody can administer is a state not worth being able to reach.
    if (!users.some((user) => user.admin && user.enabled !== false)) {
        throw new Error('A household needs an administrator who is not suspended.');
    }
    return household;
}

function read(filePath, options) {
    if (!fs.existsSync(filePath)) throw new Error(`No household file at ${filePath}.`);
    return validate(JSON.parse(fs.readFileSync(filePath, 'utf8')), options);
}

/**
 * Writes the file the way a thing that can lose power should be written: to a neighbour
 * first, then moved into place, with the previous version kept beside it. A half-written
 * household is a server that will not start.
 */
function write(filePath, household, options) {
    validate(household, options);
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
    const login = loginOf(person);
    return {
        ...household,
        users: [...household.users, {
            id,
            // Left out rather than written empty: somebody with no tailnet has no login,
            // and an empty string in the file reads as one that was meant to be filled in.
            ...(login ? { tailscaleLogin: login } : {}),
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
            if (changes.tailscaleLogin !== undefined) {
                const login = loginOf(changes);
                // Clearing one is a real edit: somebody who leaves the tailnet keeps their
                // identity, their devices and their history, and stops being found by it.
                if (login) next.tailscaleLogin = login;
                else delete next.tailscaleLogin;
            }
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

/**
 * The file with two people able to reach each other, checked but not written.
 *
 * Reaching somebody is something two people do together: it is what puts each of them in
 * the other's list, and what lets either of them ring the other. So this writes both
 * directions. The file can hold a one-way pair and the server reads one, but nothing the
 * console does makes one — a list where you appear to somebody who does not appear to you
 * is not a control anybody asked for.
 */
function withContact(household, ownerId, contactId) {
    const owner = clean(ownerId).toLowerCase();
    const other = clean(contactId).toLowerCase();
    for (const id of [owner, other]) {
        if (!household.users.some((user) => user.id.toLowerCase() === id)) {
            throw new Error(`There is nobody with the id ${id}.`);
        }
    }
    if (owner === other) throw new Error(`${owner} cannot reach themselves.`);

    const contacts = [...(household.contacts || [])];
    const held = new Set(contacts.map((item) => `${clean(item.ownerId).toLowerCase()}→${clean(item.contactId).toLowerCase()}`));
    const order = contacts.reduce((most, item) => Math.max(most, Number(item.sortOrder) || 0), 0);
    const put = (from, to) => {
        if (!held.has(`${from}→${to}`)) contacts.push({ ownerId: from, contactId: to, sortOrder: order + 1 });
    };
    put(owner, other);
    put(other, owner);
    return { ...household, contacts };
}

/** The file with two people no longer able to reach each other, in either direction. */
function withoutContact(household, ownerId, contactId) {
    const owner = clean(ownerId).toLowerCase();
    const other = clean(contactId).toLowerCase();
    const isThePair = (item) => {
        const from = clean(item.ownerId).toLowerCase();
        const to = clean(item.contactId).toLowerCase();
        return (from === owner && to === other) || (from === other && to === owner);
    };
    return { ...household, contacts: (household.contacts || []).filter((item) => !isThePair(item)) };
}

/**
 * The file with everybody able to reach everybody.
 *
 * The state a household with one group of people wants, and the one an operator would
 * otherwise assemble a pair at a time. It replaces the contacts rather than adding to
 * them, because that is what "everybody" means — an exclusion somebody asked for is not
 * something this should quietly leave in place.
 */
function withEveryoneConnected(household) {
    const ids = household.users.map((user) => user.id.toLowerCase());
    const contacts = [];
    for (const owner of ids) {
        for (const other of ids) {
            if (owner !== other) contacts.push({ ownerId: owner, contactId: other, sortOrder: 0 });
        }
    }
    return { ...household, contacts };
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
    withContact,
    withoutContact,
    withEveryoneConnected,
    backupPath: (filePath) => `${filePath}.previous`,
    path: (dir) => path.resolve(dir, 'family.json'),
};
