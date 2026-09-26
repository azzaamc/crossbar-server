'use strict';

// The setup wizard's engine: the questions a fresh deployment has to be asked, the answers
// written through the machinery `node src/admin.js mode` already uses, and the things that can
// only be reported rather than set.
//
// Three properties decide its shape.
//
// **It cannot leave a half-filled block.** Every mode it is asked to configure is completed in
// one pass — the names `MODE_REQUIRED` lists for it, plus the public bind address Caddy cannot
// render without — and the whole `.env` is composed and checked in memory before a byte of it is
// written. That is the fix for the state that closes a working front door: a file that says
// `public` while its public block is empty starts the public shaper, which cannot render the
// Caddyfile and schedules `tailscale serve off`, and when the grace window ends there is no door
// in either direction. Nothing outside the box can undo that, so the wizard refuses before it
// writes rather than discovering it afterwards.
//
// **It is scriptable, because a second and a third household exist.** Every question is
// answerable by flag and by an `--answers` file; a terminal is asked only for what neither
// supplied, and with no terminal it refuses and names what is missing rather than inventing a
// default for something that changes behaviour. A value the file already holds is offered as the
// default, because re-running is the ordinary case and must not clobber.
//
// **It reuses the deployment's own machinery.** `applyMode` writes the mode section,
// `writeEnvFile` writes the file and keeps what it replaced, `verifyEnvFile` decides whether the
// result holds up — and puts back what it replaced when it does not — `src/directory.js` decides
// what a directory may be, and `diagnostics`' STUN probe and public-bind check are what the
// report at the end is made of. Nothing here writes a file the switch does not already write.
//
// Node's standard library is all it loads at the top, on purpose: `install.sh` calls it between
// the code copy and `npm ci`, which is before `node_modules` exists. `diagnostics` is the one
// module that would break that (`ws` is a dependency), so it is required lazily inside the check
// that needs it, and a check that cannot load its probe says so instead of stopping setup.
//
// What the operator sees is `src/prompt.js`: a terminal framed in Clack's shapes — the menu, the
// fields with their defaults shown, the box at the end — and, with no terminal, the same frames
// written into the log with none of the escape sequences in them. The questions are the only
// thing that changes; an answer is written the same way whichever way it arrived.

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
    MODES, MODE_REQUIRED, applyMode, modeBlock, modeConfigured, setEnvLine, verifyEnvFile,
    writeEnvFile, writtenMode,
} = require('./config');
const directoryFile = require('./directory');
const prompts = require('./prompt');

/** The default `loadConfig` falls back to, so the probe reports on the server the same address. */
const DEFAULT_STUN = 'stun:stun.l.google.com:19302';

/** A refusal this wizard makes before it writes anything, as a sentence for the operator. */
class SetupRefusal extends Error {}

/** 32 bytes of hex — what the runbook's `openssl rand -hex 32` produced, from `node:crypto`. */
const SECRET_BYTES = 32;

function generateSecret() {
    return crypto.randomBytes(SECRET_BYTES).toString('hex');
}

// ── The answers, from flags and from a file ─────────────────────────────────────
//
// One vocabulary for both, so the two cannot drift apart: a key, the flag that sets it, and the
// JSON name in an `--answers` file are the same word.

/** Every answer this wizard reads, in the order the questions are asked. */
const ANSWER_KEYS = Object.freeze([
    'mode', 'inForce',
    'privateHostname', 'privateOrigin',
    'publicHostname', 'publicOrigin', 'publicBindAddress',
    'people', 'directory',
    'turnHost', 'turnSecret',
    'apnsKeyId', 'apnsTeamId', 'apnsKeyPath', 'apnsTopic',
    'vapidPublicKey', 'vapidPrivateKey', 'vapidSubject',
    'sessionSecret', 'newSecrets', 'password',
]);

/** `publicBindAddress` is set by `--public-bind-address`, so the two spellings cannot drift. */
const flagName = (key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

/**
 * Every flag this command takes. Anything else is refused rather than ignored: a flag `setup`
 * does not read does nothing at all, which looks exactly like a flag that worked — the same
 * silent failure an answer nothing reads has, and the one `unreadEnvKeys` exists to catch in
 * `.env`.
 */
const SETUP_OPTIONS = Object.freeze([
    ...ANSWER_KEYS.map((key) => flagName(key).slice(2)),
    'answers', 'no-ask', 'skip-checks', 'help',
]);

/**
 * Everything the command line says, as answers: an `--answers` file first, then the flags over
 * it, because a flag is the more specific thing to have typed.
 *
 * A name the file sets that is not on `ANSWER_KEYS` is refused rather than ignored, for the same
 * reason a flag is: a typo'd key would otherwise leave the wizard asking for — or defaulting —
 * the thing the file meant to set.
 */
function answersFromOptions(options) {
    const unknownFlag = Object.keys(options).filter((name) => !SETUP_OPTIONS.includes(name));
    if (unknownFlag.length) {
        throw new SetupRefusal(`setup does not take ${unknownFlag.map((name) => `--${name}`).join(', ')}.`
            + ' `node src/admin.js setup --help` lists every answer it does take.');
    }
    let held = {};
    if (typeof options.answers === 'string') {
        const file = path.resolve(process.cwd(), options.answers);
        if (!fs.existsSync(file)) throw new SetupRefusal(`No answers file at ${file}.`);
        try {
            held = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            throw new SetupRefusal(`${file} is not JSON: ${error.message}`);
        }
        if (!held || typeof held !== 'object' || Array.isArray(held)) {
            throw new SetupRefusal(`${file} has to hold one JSON object of answers.`);
        }
        const unknown = Object.keys(held).filter((key) => !ANSWER_KEYS.includes(key));
        if (unknown.length) {
            throw new SetupRefusal(`${file} sets ${unknown.map((key) => `"${key}"`).join(', ')},`
                + ` which setup does not read. The answers are: ${ANSWER_KEYS.join(', ')}.`);
        }
    }
    const fromFlags = {};
    for (const key of ANSWER_KEYS) {
        const value = options[flagName(key).slice(2)];
        if (value === undefined) continue;
        fromFlags[key] = value === true ? true : String(value);
    }
    return { ...held, ...fromFlags };
}

/**
 * The wizard's terminal, when it has one.
 *
 * Not a single question but the whole rendering layer `src/prompt.js` builds: the frames, the
 * arrow keys, the spinner — and the one thing that cannot be drawn into a log. Which is why this
 * returns nothing at all when there is no terminal, and the questions then fall to naming what
 * only a terminal could have answered.
 */
function makeTerminal() {
    const terminal = prompts.createPrompter();
    return terminal.present ? terminal : null;
}

/**
 * The injected prompt layer, told apart: `src/prompt.js`'s prompter, which can draw, or a plain
 * `(message, fallback) -> answer` function, which can only ask. A prompter with no terminal behind
 * it is the first of those that cannot draw a thing, and is no layer at all — which is what makes
 * the refusal below name the answers rather than fail on a frame nobody can see.
 */
const askLayer = (ask) => (typeof ask === 'function'
    ? { asker: ask, terminal: null }
    : { asker: null, terminal: ask && ask.present === true ? ask : null });

/**
 * Where the report goes. A terminal frames it — the `┌`, the box, the `└` — and anything else gets
 * the same frames written into `log`, character for character and with none of the escape
 * sequences: a log file is not a screen, and the browser page's `<pre>` is not one either.
 */
function makeReport(terminal, log) {
    return terminal || prompts.createPresentation({ write: (line) => log(line) });
}

// ── What the deployment already holds ───────────────────────────────────────────

/**
 * One name as a string, read the way `loadDotEnv` reads it: the first line that sets it, since
 * that is the line the server keeps, with the same surrounding quotes dropped.
 *
 * A reader of its own rather than `loadDotEnv`, because this has to answer about a file
 * `loadConfig` refuses — a public block with its hostname line still empty is the state the
 * wizard exists to repair — and `loadDotEnv` only writes into `process.env`.
 */
function settingIn(content, name, fallback = '') {
    for (const rawLine of String(content ?? '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const equals = line.indexOf('=');
        if (equals < 1 || line.slice(0, equals).trim() !== name) continue;
        let value = line.slice(equals + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        return value;
    }
    return fallback;
}

/**
 * What is already in the deployment: the `.env` (or the template it is seeded from), the two mode
 * blocks, and the directory file the configuration names.
 *
 * The directory file is read the way the server reads it — `directoryFile.read`, logins and all —
 * so what the wizard offers back is what will actually be served, and a file it cannot read is a
 * problem it reports rather than one it works around.
 */
function readState(dir) {
    const envPath = path.join(dir, '.env');
    const templatePath = path.join(dir, '.env.example');
    const hasEnv = fs.existsSync(envPath);
    const content = hasEnv ? fs.readFileSync(envPath, 'utf8')
        : (fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : '');
    const directoryPath = path.resolve(dir, settingIn(content, 'DIRECTORY_CONFIG_PATH', './data/directory.json'));

    let directory = null;
    let directoryProblem = null;
    if (fs.existsSync(directoryPath)) {
        try {
            directory = directoryFile.read(directoryPath);
        } catch (error) {
            directoryProblem = `${directoryPath} cannot be used as it is: ${String(error && error.message)}`;
        }
    }

    return {
        dir,
        envPath,
        templatePath,
        hasEnv,
        content,
        written: writtenMode(content),
        block: Object.fromEntries(MODES.map((mode) => [mode, modeBlock(content, mode)])),
        directoryPath,
        directory,
        directoryProblem,
        dataDir: path.resolve(dir, settingIn(content, 'DATA_DIR', './data')),
        stunUrl: settingIn(content, 'ICE_STUN_URL', DEFAULT_STUN),
        turnHost: settingIn(content, 'CROSSBAR_TURN_HOST'),
        secrets: {
            session: settingIn(content, 'CROSSBAR_SESSION_SECRET'),
            turn: settingIn(content, 'CROSSBAR_TURN_SHARED_SECRET'),
        },
        vapid: {
            publicKey: settingIn(content, 'VAPID_PUBLIC_KEY'),
            privateKey: settingIn(content, 'VAPID_PRIVATE_KEY'),
            subject: settingIn(content, 'VAPID_SUBJECT'),
        },
        apns: {
            keyId: settingIn(content, 'CROSSBAR_APNS_KEY_ID'),
            teamId: settingIn(content, 'CROSSBAR_APNS_TEAM_ID'),
            keyPath: settingIn(content, 'CROSSBAR_APNS_KEY_PATH'),
            topic: settingIn(content, 'CROSSBAR_APNS_TOPIC'),
        },
    };
}

// ── The questions ───────────────────────────────────────────────────────────────

/**
 * The addresses each mode is asked for, in the order they are asked. `name` is the block name
 * `.env` spells `NETWORK_MODE_<MODE>_<NAME>`, so what is asked and what is written are the same
 * word.
 *
 * Private mode is not asked for a bind address: it is reached through the tailnet proxy, which
 * serves the loopback listener, so there is no address of its own to bind.
 */
const ADDRESS_QUESTIONS = Object.freeze({
    private: Object.freeze([
        { key: 'privateHostname', name: 'HOSTNAME', prompt: 'the tailnet name this deployment is reached at' },
        { key: 'privateOrigin', name: 'ORIGIN', prompt: 'the origin invitations carry' },
    ]),
    public: Object.freeze([
        { key: 'publicHostname', name: 'HOSTNAME', prompt: 'the name Caddy serves for this deployment' },
        { key: 'publicOrigin', name: 'ORIGIN', prompt: 'the origin invitations carry' },
        { key: 'publicBindAddress', name: 'BIND_ADDRESS', prompt: 'the address Caddy binds (never 0.0.0.0)' },
    ]),
});

/**
 * What this wizard insists on beyond what the server does. `MODE_REQUIRED` says what stops the
 * *server*; this says what stops the front door the wizard is setting up.
 *
 * The public bind address is on it because a public block with none is a Caddy that cannot render
 * the Caddyfile, and the value that looks right — the wildcard — is refused by the doctor for a
 * measured reason: tailscaled already holds `0.0.0.0:443` in public mode, so Caddy never takes the
 * port and never obtains a certificate, which surfaces as a TLS failure about a hostname that is
 * perfectly configured. The wizard refuses both before writing.
 */
const WIZARD_REQUIRED = Object.freeze({ private: Object.freeze([]), public: Object.freeze(['BIND_ADDRESS']) });

const WILDCARD_BINDS = Object.freeze(['0.0.0.0', '::', '[::]', '*']);

/**
 * Why this address cannot be bound, as a sentence, or null when it can. It is one function because
 * it is one refusal: a field says it while the wildcard is being typed, and the same sentence
 * stops the same address arriving by flag or by answers file.
 */
function bindAddressProblem(mode, address) {
    if (!WILDCARD_BINDS.includes(String(address))) return null;
    return `${modeLabel(mode)} cannot bind ${address}: every address includes the one tailscaled`
        + ' already holds in public mode, so Caddy never takes the port and never obtains a certificate'
        + ' — what an operator sees then is a TLS failure about a hostname that is configured correctly.'
        + ' Name the one address this deployment is reached at.';
}

/** The one question that decides every other one, as a menu and as a line. */
const MODE_QUESTION = 'Which modes is this deployment reached in — private, public, or both?';

/** The three answers `--mode` takes, as the menu they are chosen from, with what each one costs. */
const MODE_OPTIONS = Object.freeze([
    { value: 'private', label: 'Private (tailnet)', hint: 'reached over Tailscale, from anywhere on it' },
    { value: 'public', label: 'Public (open internet)', hint: 'Caddy, a certificate, and a name that points here' },
    { value: 'both', label: 'Both', hint: 'private now, public once its name points here' },
]);

/** What is about to be asked in step 4, said once rather than five times. */
const OPTIONAL_NOTE = `A deployment works without any of these, and the summary says what it went
without:

  Relay     a TURN host, for media that cannot go direct
  APNs      a key from the developer account, for ringing a phone whose screen is off
  Web Push  a VAPID key pair, for waking a browser that is closed

Blank at any of them skips it.`;

const requiredIn = (mode) => [...MODE_REQUIRED[mode], ...WIZARD_REQUIRED[mode]];
const blockKey = (mode, name) => `NETWORK_MODE_${mode.toUpperCase()}_${name}`;

/** The label a mode is spoken about with, and the one the summary's column has room for. */
const modeLabel = (mode) => (mode === 'private' ? 'Private (tailnet)' : 'Public (open internet)');
const MODE_LABEL = Object.freeze({ private: 'Private', public: 'Public' });

/** `1 person`, `2 people` — the counts in the report are read by a person. */
const peopleCount = (count) => `${count} ${count === 1 ? 'person' : 'people'}`;

/** `private`, `public` or `both` — as a list of modes, refusing anything else by name. */
function parseModes(value) {
    const wanted = String(value ?? '').trim().toLowerCase();
    if (wanted === 'both' || wanted === 'all') return [...MODES];
    if (MODES.includes(wanted)) return [wanted];
    throw new SetupRefusal(`"${value}" is not a mode: --mode takes private, public, or both.`);
}

/** One person, as the line a person types and as the object an answers file holds. */
function parsePersonLine(line) {
    const [id, name, login, ...rest] = String(line).split(',').map((part) => part.trim());
    if (!id || !name) {
        throw new SetupRefusal(`"${line}" is not a person. Write one as "id, display name, login, admin" —`
            + ' the login and the administrator flag may be left blank.');
    }
    return { id, name, login: login || '', admin: rest.some((part) => /^(admin|yes|true|1)$/i.test(part)) };
}

/** The same person, as an answers file or `--people` may hold them. */
function normalizePerson(entry) {
    if (typeof entry === 'string') return parsePersonLine(entry);
    const id = String(entry?.id ?? '').trim();
    const name = String(entry?.name ?? entry?.displayName ?? '').trim();
    if (!id || !name) {
        throw new SetupRefusal(`A person in --people needs an id and a name; "${JSON.stringify(entry)}" has`
            + ' neither. The shape is { "id": "abdullah", "name": "Abdullah", "login": "abdullah@dev", "admin": true }.');
    }
    return {
        id,
        name,
        login: String(entry?.login ?? entry?.tailscaleLogin ?? '').trim(),
        admin: Boolean(entry?.admin),
    };
}

/** `--people` as a JSON array, or `@file` naming one, resolved against the deployment's own tree. */
function parsePeople(value, dir = process.cwd()) {
    if (Array.isArray(value)) return value.map(normalizePerson);
    const text = String(value ?? '').trim();
    let parsed;
    try {
        parsed = JSON.parse(text.startsWith('@') ? fs.readFileSync(path.resolve(dir, text.slice(1)), 'utf8') : text);
    } catch (error) {
        throw new SetupRefusal(`--people has to be a JSON array of people, or @file naming one: ${error.message}`);
    }
    if (!Array.isArray(parsed) || !parsed.length) throw new SetupRefusal('--people has to be a non-empty JSON array of people.');
    return parsed.map(normalizePerson);
}

/** The line a person reads back as, so what is offered as the default is what a person would type. */
const personLine = (person) => [person.id, person.displayName, person.tailscaleLogin || '', person.admin ? 'admin' : ''].join(', ');

/**
 * The people, as the directory file: everybody reaches everybody else, and the one group the
 * example file has. A directory nobody can call anybody from reads as an empty app, so the pairs
 * are written rather than left for a table of ticks that the console does not have.
 */
function directoryFromPeople(people) {
    const users = people.map((person) => ({
        id: person.id,
        ...(person.login ? { tailscaleLogin: person.login.toLowerCase() } : {}),
        displayName: person.name,
        ...(person.admin ? { admin: true } : {}),
    }));
    const memberIds = users.map((user) => user.id.toLowerCase());
    return directoryFile.withEveryoneConnected({
        users,
        contacts: [],
        groups: [{ id: 'everyone', displayName: 'Everyone', memberIds }],
    });
}

/**
 * The people, one field at a time, with "another person?" between them — the shape a terminal can
 * ask. A directory file already there is offered back first, because keeping it is the ordinary
 * case and naming people over it is the exception.
 *
 * An empty list is the answer "keep what is there": the caller reads it that way.
 */
async function askPeopleByFields(terminal, state) {
    if (state.directory) {
        const kept = await terminal.confirm({
            message: `Keep the ${peopleCount(state.directory.users.length)} already in ${state.directoryPath}?`,
            initialValue: true,
        });
        if (kept) return [];
    }
    const people = [];
    for (;;) {
        const first = people.length === 0;
        const someone = {
            id: await terminal.text({
                message: `${first ? 'The first person' : 'Another person'}: the id the console knows them by`,
                placeholder: 'abdullah',
                validate: (value) => (value ? undefined : 'An id is how everybody else names them.'),
            }),
            name: await terminal.text({
                message: 'their display name',
                placeholder: 'Abdullah',
                validate: (value) => (value ? undefined : 'A name is what the console shows.'),
            }),
            login: await terminal.text({
                message: 'their tailscale login, if the tailnet names them — blank when it does not',
                placeholder: 'abdullah@dev',
            }),
            admin: await terminal.confirm({ message: 'an administrator?', initialValue: first }),
        };
        people.push(someone);
        if (!await terminal.confirm({ message: 'another person?', initialValue: false })) return people;
    }
}

/**
 * The people, one line each — the shape anything plainer than a terminal can be asked. A blank
 * line answers for the whole file: done when there is none yet, and "keep what is there" when
 * there is.
 */
async function askPeopleByLines(ask, report, state) {
    report.note(`One person per line, as "id, display name, login, admin", and a blank line to`
        + ` ${state.directory ? `keep the ${peopleCount(state.directory.users.length)} already there` : 'say you are done'}.`
        + ' The login and the administrator flag may be left blank.', 'The directory');
    const people = [];
    for (;;) {
        const named = await ask('Person', '');
        if (!named) return people;
        people.push(parsePersonLine(named));
    }
}

/**
 * Ask every question, in order, and answer each one from the flags, the file, the terminal — or
 * refuse, naming what is missing.
 *
 * The rule throughout is: an answer, then what the deployment already holds, then the terminal.
 * Only a value that none of the three can produce is missing, which is what makes a second run
 * over a configured deployment a no-op and an unattended run of a file that does not exist a
 * refusal rather than a guess. A default is derived only where it changes nothing — the origin is
 * the hostname with `https://` in front, the mode in force is the mode the file already says.
 *
 * Where the questions go is two things, because they are not the same thing: `terminal` is the
 * prompter `src/prompt.js` builds, which draws a menu and a field and a confirmation, and `asker`
 * is a plain `(message, fallback) -> answer`, which can only ask a line at a time. `src/admin.js`
 * injects the first on a terminal; a script or a test injects the second, and the questions the
 * prompter would have drawn are then asked as lines — the same questions, and the same answers
 * written from them. `report` is wherever the wizard is allowed to say something, which is the
 * same prompter, or `src/prompt.js`'s frames written plainly into the log.
 */
async function collectAnswers({ answers, state, asker, terminal, report, generate }) {
    const misses = [];
    const supplied = (key) => {
        const value = answers[key];
        return value === undefined || value === '' || value === false ? null : value;
    };

    /**
     * One line of text: what the flags or the file said, or what the terminal says, or what the
     * deployment already holds — shown in the field and taken by Enter, so a second run over a
     * live deployment is a matter of pressing it. A question nothing can answer is left to the
     * refusal at the end rather than guessed at.
     */
    const line = async ({ key, message, held = '', validate = null }) => {
        const given = supplied(key);
        if (given !== null) return String(given);
        if (terminal) {
            return String(await terminal.text({
                message,
                placeholder: held,
                defaultValue: held,
                validate: validate || undefined,
            }));
        }
        if (asker) {
            const typed = await asker(message, held);
            const value = typed === '' ? held : String(typed);
            const refused = validate ? validate(value) : null;
            if (refused) throw new SetupRefusal(refused);
            return value;
        }
        return held;
    };

    /** The same, for a question the deployment cannot do without. */
    const needed = async (question) => {
        const value = await line(question);
        if (!value) misses.push(question.key);
        return value;
    };

    // 1. Which modes. Nothing is complete until this is answered, and it decides every question
    //    after it, so it is refused on its own rather than listed beside the answers it shapes.
    const modeGiven = supplied('mode');
    let modeAnswer;
    if (modeGiven !== null) modeAnswer = String(modeGiven);
    else if (terminal) {
        modeAnswer = String(await terminal.select({
            message: MODE_QUESTION,
            options: MODE_OPTIONS,
            initial: state.written || 'private',
        }));
    } else if (asker) modeAnswer = (await asker(MODE_QUESTION, state.written || 'private')) || state.written;
    else modeAnswer = state.written;
    if (!modeAnswer) throw new SetupRefusal(noTerminalMessage(['mode'], Boolean(asker || terminal)));
    const modes = parseModes(modeAnswer);

    // 2. The addresses each chosen mode is reached at.
    const blocks = Object.fromEntries(MODES.map((mode) => [mode, { HOSTNAME: '', ORIGIN: '', BIND_ADDRESS: '' }]));
    for (const mode of modes) {
        for (const question of ADDRESS_QUESTIONS[mode]) {
            const held = state.block[mode][question.name];
            const derived = question.name === 'ORIGIN' && blocks[mode].HOSTNAME ? `https://${blocks[mode].HOSTNAME}` : '';
            const bindProblem = question.name === 'BIND_ADDRESS' ? (address) => bindAddressProblem(mode, address) : null;
            const asking = {
                key: question.key,
                message: `${modeLabel(mode)}: ${question.prompt}`,
                held: held || derived,
                validate: bindProblem,
            };
            const value = requiredIn(mode).includes(question.name) ? await needed(asking) : await line(asking);
            // The wildcard is refused wherever it came from: the field refuses it while it is
            // being typed, and this catches the same address arriving by flag or by answers file.
            const refused = bindProblem ? bindProblem(value) : null;
            if (refused) throw new SetupRefusal(refused);
            blocks[mode][question.name] = value;
        }
    }

    // 3. The directory of people, their logins, and who administers. A directory file already in
    //    place is kept unless the answers or the terminal name people, which is what makes
    //    re-running over a live deployment a no-op.
    let directory = null;
    const givenPeople = supplied('people');
    const givenDirectory = supplied('directory');
    if (givenPeople !== null && givenDirectory !== null) {
        throw new SetupRefusal('--people and --directory are two answers to one question: give one of them.');
    } else if (givenDirectory !== null) {
        const file = path.resolve(state.dir, String(givenDirectory));
        try {
            directory = directoryFile.read(file);
        } catch (error) {
            throw new SetupRefusal(`The directory file at ${file} cannot be used: ${String(error && error.message)}`);
        }
    } else if (givenPeople !== null) {
        directory = directoryFromPeople(parsePeople(givenPeople, state.dir));
    } else if (terminal || asker) {
        // The rule the whole wizard follows, for the one question a blank answer can also settle:
        // people named outright, or the file the deployment already has, and never an empty one.
        // A terminal names them one field at a time and anything plainer one line at a time; both
        // come back as a list, and an empty one is "keep what is there".
        for (;;) {
            const named = terminal
                ? await askPeopleByFields(terminal, state)
                : await askPeopleByLines(asker, report, state);
            if (named.length) { directory = directoryFromPeople(named); break; }
            if (state.directory) break;
            if (state.directoryProblem) throw new SetupRefusal(`${state.directoryProblem}. Name the people here, or fix it and run setup again.`);
            report.note('A directory needs at least one person, and one of them has to be an administrator.', 'Not yet');
        }
    } else if (state.directory) {
        // Nothing to write: the file the deployment already has is the answer, so the wizard does
        // not touch it.
        directory = null;
    } else if (state.directoryProblem) {
        throw new SetupRefusal(`${state.directoryProblem}. Fix it, or name the people with --people.`);
    } else {
        misses.push('people');
    }

    // 4. The optional material. Every one of these is skippable, and a deployment that skips one
    //    says so in the report rather than failing later. The note is said once, and only when
    //    somebody is there to answer it: a run of nothing but flags is answering, not being asked.
    if (asker || terminal) report.note(OPTIONAL_NOTE, 'Optional material');
    const turnHost = await line({
        key: 'turnHost',
        message: 'Relay: the TURN host media which cannot go direct is relayed through — blank for no relay',
        held: state.turnHost,
    });
    const pushAnswered = ['apnsKeyId', 'apnsTeamId', 'apnsKeyPath', 'apnsTopic'].some((key) => supplied(key) !== null);
    const apnsKeyId = await line({
        key: 'apnsKeyId',
        message: 'APNs, for ringing a phone whose screen is off: the key id from the developer account — blank to skip',
        held: state.apns.keyId,
    });
    const apns = { keyId: apnsKeyId, teamId: state.apns.teamId, keyPath: state.apns.keyPath, topic: state.apns.topic };
    if (apnsKeyId || pushAnswered) {
        apns.teamId = await line({ key: 'apnsTeamId', message: 'APNs: the team id', held: state.apns.teamId });
        apns.keyPath = await line({ key: 'apnsKeyPath', message: 'APNs: the .p8 key file on this host', held: state.apns.keyPath });
        apns.topic = await line({ key: 'apnsTopic', message: 'APNs: the app bundle id', held: state.apns.topic });
    }
    const webPushAnswered = ['vapidPublicKey', 'vapidPrivateKey', 'vapidSubject'].some((key) => supplied(key) !== null);
    const vapidPublicKey = await line({
        key: 'vapidPublicKey',
        message: 'Web Push for browser clients: the VAPID public key — blank to skip',
        held: state.vapid.publicKey,
    });
    const vapid = { publicKey: vapidPublicKey, privateKey: state.vapid.privateKey, subject: state.vapid.subject };
    if (vapidPublicKey || webPushAnswered) {
        vapid.privateKey = await line({ key: 'vapidPrivateKey', message: 'Web Push: the VAPID private key', held: state.vapid.privateKey });
        vapid.subject = await line({ key: 'vapidSubject', message: 'Web Push: the contact subject (mailto: or a URL)', held: state.vapid.subject });
    }

    // 5. What can be generated. A secret the file already holds is kept, because replacing the
    //    session secret signs every device out; `--new-secrets` is how somebody asks for that.
    const fresh = Boolean(answers.newSecrets);
    const sessionGiven = supplied('sessionSecret');
    const session = sessionGiven ? String(sessionGiven) : (fresh ? '' : state.secrets.session) || generate();
    const turnGiven = supplied('turnSecret');
    if (turnGiven && !turnHost) {
        throw new SetupRefusal('--turn-secret names a relay shared secret and no relay host: give --turn-host'
            + ' as well, or neither — a secret for no relay is a secret nothing reads.');
    }
    const turn = !turnHost ? state.secrets.turn
        : (turnGiven ? String(turnGiven) : (fresh ? '' : state.secrets.turn) || generate());

    // Which of the chosen modes is in force. Not a question: the file already answers it, and when
    // it says nothing the answer is the default `loadConfig` uses, so writing it down changes
    // nothing about which mode is in force.
    const inForceAnswer = supplied('inForce');
    const derived = state.written && modes.includes(state.written)
        ? state.written
        : (modes.includes('private') ? 'private' : 'public');
    const inForce = String(inForceAnswer ?? derived);
    if (!modes.includes(inForce)) {
        throw new SetupRefusal(`--in-force is ${inForce}, which is not one of the modes being set up (${modes.join(', ')}).`);
    }

    if (misses.length) throw new SetupRefusal(noTerminalMessage(misses, Boolean(asker || terminal)));

    return {
        modes,
        inForce,
        blocks,
        directory,
        // Logins are how somebody is found where the tailnet names the caller, which is what
        // `src/api.js` decides the same question from (`config.trustTailscaleHeaders`): required
        // in private mode, a record of who somebody is elsewhere in public mode.
        requireLogins: inForce === 'private',
        turnHost,
        vapid,
        apns,
        password: Boolean(answers.password),
        secrets: {
            session,
            turn,
            sessionFrom: sessionGiven ? 'given' : ((!fresh && state.secrets.session) ? 'kept' : 'generated'),
            turnFrom: !turnHost ? 'unset' : (turnGiven ? 'given' : ((!fresh && state.secrets.turn) ? 'kept' : 'generated')),
        },
    };
}

/**
 * What a run with no terminal can be told, listing every answer it lacks rather than the first:
 * the whole point of the flag and `--answers` paths is that they can be written in one go.
 */
function noTerminalMessage(misses, asked) {
    const header = asked
        ? 'setup could not finish: these answers are still missing, and the terminal gave nothing for them.'
        : 'setup has no terminal to ask on, and no answer for these:';
    const lines = misses.map((key) => `  ${flagName(key).padEnd(24)}${answerHelp(key)}`);
    return [header, ...lines, 'Pass them as flags, or write them into a file and pass --answers <file>.',
        '`node src/admin.js setup --help` lists every answer.'].join('\n');
}

/** What one missing answer is for, in the refusal above. */
function answerHelp(key) {
    return {
        mode: 'private, public, or both',
        privateHostname: 'the tailnet name this deployment is reached at',
        privateOrigin: 'the origin invitations carry',
        publicHostname: 'the name Caddy serves',
        publicOrigin: 'the origin invitations carry',
        publicBindAddress: 'the address Caddy binds, never a wildcard',
        people: 'the directory: a JSON array of { id, name, login, admin }, or @file',
    }[key] || 'an answer this deployment needs';
}

// ── Composing, and the rule before writing ──────────────────────────────────────

/**
 * The `.env` the answers produce: each chosen mode's own block, the names the answers set, and
 * then the switch's own section through `applyMode` — so the section a switch would write and the
 * section the wizard writes are the same bytes, written by the same code.
 *
 * Pure, and called before anything is written, so a refusal here costs nothing.
 */
function composeEnv(state, resolved) {
    let content = state.content;
    for (const mode of resolved.modes) {
        content = setEnvLine(content, blockKey(mode, 'HOSTNAME'), resolved.blocks[mode].HOSTNAME);
        content = setEnvLine(content, blockKey(mode, 'ORIGIN'), resolved.blocks[mode].ORIGIN);
        // Only public has an address of its own to bind: private is reached through the tailnet
        // proxy, which serves the loopback listener.
        if (mode === 'public') content = setEnvLine(content, blockKey(mode, 'BIND_ADDRESS'), resolved.blocks.public.BIND_ADDRESS);
    }
    content = setEnvLine(content, 'CROSSBAR_SESSION_SECRET', resolved.secrets.session);
    if (resolved.turnHost) {
        content = setEnvLine(content, 'CROSSBAR_TURN_HOST', resolved.turnHost);
        content = setEnvLine(content, 'CROSSBAR_TURN_SHARED_SECRET', resolved.secrets.turn);
    }
    for (const [name, value] of Object.entries({
        VAPID_PUBLIC_KEY: resolved.vapid.publicKey,
        VAPID_PRIVATE_KEY: resolved.vapid.privateKey,
        VAPID_SUBJECT: resolved.vapid.subject,
        CROSSBAR_APNS_KEY_ID: resolved.apns.keyId,
        CROSSBAR_APNS_TEAM_ID: resolved.apns.teamId,
        CROSSBAR_APNS_KEY_PATH: resolved.apns.keyPath,
        CROSSBAR_APNS_TOPIC: resolved.apns.topic,
    })) {
        // Blank means "not set up here, leave what is there": writing the name with nothing after
        // it would say the capability is configured, and the two are not the same thing.
        if (value) content = setEnvLine(content, name, value);
    }
    return applyMode(content, resolved.inForce);
}

/**
 * The mode rule, asked of the file that is about to be written: every name a chosen mode needs,
 * for every mode chosen, present in the composed content. Nothing is written until this is empty.
 */
function shortfall(resolved, env) {
    const short = [];
    for (const mode of resolved.modes) {
        const block = modeBlock(env, mode);
        for (const name of requiredIn(mode)) {
            if (!block[name]) short.push(blockKey(mode, name));
        }
    }
    return short;
}

// ── Writing, and the check that decides it ──────────────────────────────────────

/**
 * `writeEnvFile` keeps the file it replaces in `DATA_DIR`, and reads that name from the
 * environment. The wizard knows the deployment's data directory from the file it is writing —
 * `install.sh` copies the code and never carries `data/`, so the resolved path is the one thing a
 * fresh box gets wrong — and hands it over the only way the writer takes it, putting back
 * whatever was there so a library call does not edit the caller's environment.
 */
function withDataDir(dataDir, run) {
    const previous = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    try {
        return run();
    } finally {
        if (previous === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = previous;
    }
}

/** The directory file as it was, or gone again when there was none: a failed write leaves nothing. */
function restoreDirectory(state) {
    if (state.directory) directoryFile.write(state.directoryPath, state.directory, { requireLogins: false });
    else fs.rmSync(state.directoryPath, { force: true });
}

/**
 * Write both files, then ask the same questions of the result that the switch asks — and put both
 * back if either answer is no.
 *
 * `verifyEnvFile` decides success, exactly as it does for a mode switch: it is a child process
 * reading nothing but this file, which is the question a restart asks. The mode predicate is asked
 * per chosen mode as well, because a deployment that will be shaped for public later has to have a
 * complete public block now, and `verifyEnvFile` only speaks for the mode in force.
 */
function writeDeployment({ state, resolved, env }) {
    let wroteEnv = false;
    let wroteDirectory = false;
    const restore = () => {
        if (wroteEnv) {
            if (state.hasEnv) writeEnvFile(state.envPath, state.content);
            else fs.rmSync(state.envPath, { force: true });
        }
        if (wroteDirectory) restoreDirectory(state);
    };

    try {
        withDataDir(state.dataDir, () => {
            writeEnvFile(state.envPath, env);
            wroteEnv = true;
            if (resolved.directory) {
                directoryFile.write(state.directoryPath, resolved.directory, { requireLogins: resolved.requireLogins });
                wroteDirectory = true;
            }
        });
    } catch (error) {
        withDataDir(state.dataDir, restore);
        throw new SetupRefusal(`Nothing was left half-written: ${String(error && error.message)}`);
    }

    for (const mode of resolved.modes) {
        const check = modeConfigured(mode, state.envPath);
        if (!check.configured) {
            withDataDir(state.dataDir, restore);
            throw new SetupRefusal(`Nothing was left half-written: ${mode} would not be complete — ${check.missing.join(', ')}.`);
        }
    }

    const check = verifyEnvFile(state.dir, resolved.inForce);
    if (!check.ok) {
        withDataDir(state.dataDir, restore);
        throw new SetupRefusal(`Nothing was left half-written: the file it wrote does not load — ${check.message}`);
    }
    return check;
}

// ── What can be checked here but not set here ───────────────────────────────────

/** 100.64.0.0/10, the range a carrier-grade NAT hands out — the one tell that is readable locally. */
const CARRIER_GRADE = /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./;
/** Addresses that cannot be reached from the internet, whatever translation is in the path. */
const NOT_PUBLIC = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|127\.|169\.254\.|f[cd])/i;

/** Every address this box itself holds, which is what "points at this host" is decided against. */
function hostAddresses() {
    return Object.values(os.networkInterfaces()).flat()
        .filter((entry) => entry && !entry.internal)
        .map((entry) => entry.address);
}

/**
 * What the address the internet sees says about this box, given the addresses it holds itself.
 *
 * The honest limit is stated rather than papered over: whether the ISP's NAT is carrier-grade is
 * settled by the address's range when it is in 100.64.0.0/10, and is not determinable from inside
 * when it is anything else — only the ISP can say, which is what `deploy/README.md` §8.3 tells an
 * operator. So a private mapped address says more than one NAT is in the path and no more.
 */
function natVerdict(mapped, locals = []) {
    const address = String(mapped?.address || '');
    const where = `${address}:${mapped?.port}`;
    if (locals.includes(address)) {
        return { verdict: 'ok', detail: `the internet sees ${where}, which is this host's own address: nothing is translating, and public mode needs no port forward` };
    }
    if (CARRIER_GRADE.test(address)) {
        return { verdict: 'warn', detail: `the internet sees ${where}, which is a carrier-grade NAT address: a port forward cannot be made from here, so public mode would answer nobody — and only the ISP can lift it` };
    }
    if (NOT_PUBLIC.test(address)) {
        return { verdict: 'unknown', detail: `the internet sees the private address ${where}, so more than one NAT is in the path; whether one of them is carrier-grade could not be determined from here` };
    }
    return { verdict: 'warn', detail: `the internet sees ${where}, which is not an address on this host: something is translating, and public mode needs a port forward from it` };
}

/** Whether the name Caddy serves points here, which no check inside the box can set for it. */
async function hostnameVerdict(hostname, mapped, locals) {
    const settled = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
    const addresses = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    if (!addresses.length) {
        return { verdict: 'fail', detail: `${hostname} does not resolve, so Caddy cannot obtain a certificate for it: the name has to point here first` };
    }
    if (mapped && addresses.includes(mapped)) {
        return { verdict: 'ok', detail: `${hostname} points at the address the internet sees for this box (${mapped})` };
    }
    const here = addresses.filter((address) => locals.includes(address));
    if (here.length) return { verdict: 'ok', detail: `${hostname} points at this host (${here.join(', ')})` };
    return {
        verdict: 'warn',
        detail: `${hostname} points at ${addresses.join(', ')}, which is not an address on this host: that is right`
            + ' only if something in front forwards the name here, because the certificate Caddy asks for has to reach this box',
    };
}

/**
 * The report at the end: the STUN probe first, because what the internet sees decides how the
 * hostname's answer reads, then the checks that only public mode has.
 *
 * A check that cannot be run is reported as such rather than as a failure. That includes the
 * probes needing `node_modules`, which is exactly the state `install.sh` calls the wizard in.
 */
async function runChecks({ state, resolved, stunUrl, locals }) {
    const lines = [];
    const run = async (name, probe) => {
        try {
            const result = await probe();
            lines.push({ name, verdict: result.verdict, detail: result.detail });
        } catch (error) {
            lines.push({ name, verdict: 'unknown', detail: `the check could not be run: ${String(error && error.message)}` });
        }
    };

    let mapped = null;
    await run('STUN', async () => {
        const { parseStunUrl, stunQuery } = require('./diagnostics');
        const target = parseStunUrl(stunUrl || state.stunUrl);
        if (!target) {
            return { verdict: 'unknown', detail: 'no STUN server is configured, so whether this box is behind a carrier-grade NAT could not be determined' };
        }
        const answer = await stunQuery(target.host, target.port);
        if (!answer) {
            return { verdict: 'unknown', detail: `${target.host}:${target.port} did not answer, so whether this box is behind a carrier-grade NAT could not be determined` };
        }
        mapped = answer.address;
        return natVerdict(answer, locals);
    });

    if (resolved.modes.includes('public')) {
        const { checkPublicBindAddress, checkPublicIngress } = require('./diagnostics');
        const config = {
            publicHostname: resolved.blocks.public.HOSTNAME,
            publicOrigin: resolved.blocks.public.ORIGIN,
            envFile: state.envPath,
        };
        await run('Public ingress', async () => {
            const result = await checkPublicIngress(config);
            return { verdict: result.ok ? 'ok' : 'fail', detail: result.detail };
        });
        await run('Public hostname', () => hostnameVerdict(config.publicHostname, mapped, locals));
        await run('Public bind address', async () => {
            const result = checkPublicBindAddress(config);
            return { verdict: result.ok ? 'ok' : 'fail', detail: result.detail };
        });
    }
    return lines;
}

// ── The report ──────────────────────────────────────────────────────────────────

/** How a check reads in the summary: what could be made, and what could not. */
const CHECK_MARK = Object.freeze({
    ok: prompts.SYMBOL.submitted,
    warn: prompts.SYMBOL.refused,
    unknown: prompts.SYMBOL.quiet,
    fail: prompts.SYMBOL.cancelled,
});

/** How one answer reads in the summary: the value, or how it was arrived at. */
const secretWord = (from) => ({
    generated: 'generated (32 bytes of hex)', kept: 'kept from the file', given: 'given', unset: 'not set',
}[from]);

/** The two columns the summary is read down, with a long value's own lines kept under it. */
function columns(pairs, width) {
    return pairs
        .flatMap(([label, value]) => prompts.frames.wrap(value, Math.max(width - 11, 16))
            .map((part, index) => `${index ? ' '.repeat(11) : label.padEnd(11)}${part}`))
        .join('\n');
}

/** What was chosen, which is the first thing the box says. */
function chosenPairs(state, resolved) {
    const pairs = [['Modes', `${resolved.modes.join(', ')} (in force: ${resolved.inForce})`]];
    for (const mode of resolved.modes) {
        const names = [resolved.blocks[mode].HOSTNAME, resolved.blocks[mode].ORIGIN].filter(Boolean).join(' · ');
        const bind = resolved.blocks[mode].BIND_ADDRESS ? ` · binding ${resolved.blocks[mode].BIND_ADDRESS}` : '';
        pairs.push([MODE_LABEL[mode], `${names}${bind}`]);
    }
    const people = resolved.directory?.users || state.directory?.users || [];
    const administrators = people.filter((user) => user.admin && user.enabled !== false).length;
    pairs.push(['Directory', `${peopleCount(people.length)}, ${administrators}`
        + ` administrator${administrators === 1 ? '' : 's'}`]);
    pairs.push(['Relay', resolved.turnHost
        ? `${resolved.turnHost} · shared secret ${secretWord(resolved.secrets.turnFrom)}`
        : 'not configured — media that cannot go direct stays direct']);
    const push = [
        resolved.apns.keyId || resolved.apns.topic ? `APNs ${resolved.apns.keyId}${resolved.apns.topic ? ` (${resolved.apns.topic})` : ''}` : '',
        resolved.vapid.publicKey ? 'Web Push' : '',
    ].filter(Boolean);
    pairs.push(['Push', push.length
        ? push.join(' · ')
        : 'not configured — a phone whose screen is off cannot be rung, and a closed browser cannot be woken']);
    pairs.push(['Secrets', `session ${secretWord(resolved.secrets.sessionFrom)}${resolved.turnHost ? ` · relay ${secretWord(resolved.secrets.turnFrom)}` : ''}`]);
    return pairs;
}

/** What the run wrote, and what it checked about it. */
function writtenPairs(state, resolved, wroteDirectory) {
    return [
        ['Written', state.envPath],
        ['', wroteDirectory
            ? `${state.directoryPath} (${peopleCount(resolved.directory.users.length)})`
            : `${state.directoryPath} (already there, left as it is)`],
        ['Verified', `${resolved.inForce} is in force, and the file loads cleanly`],
    ];
}

/** How one check reads: the mark for what it could say, and the sentence it says under it. */
const checkLines = (checks, width) => checks.flatMap((check) => prompts.frames
    .wrap(check.detail, Math.max(width - 22, 24))
    .map((part, index) => `${index ? ' '.repeat(22) : `${CHECK_MARK[check.verdict]} ${check.name.padEnd(20)}`}${part}`));

/** What is left for a person, which is exactly what a prompt and a one-time token need. */
function nextSteps(state, resolved) {
    const admins = (resolved.directory?.users || state.directory?.users || [])
        .filter((user) => user.admin && user.enabled !== false);
    return [
        ['Then', 'systemctl restart crossbar'],
        ['', 'node src/admin.js password'],
        ['', `node src/admin.js enroll --user ${admins[0] ? admins[0].id : '<id>'}`],
    ];
}

/**
 * The box the wizard ends with: what was chosen, what was written, and which of the checks could
 * be made — plus the three commands this process deliberately does not run. It is one note because
 * it is one thing to read, and it is the last thing on the screen.
 *
 * The checks are reports and not gates, so a run that could not make one says which, in the same
 * place as the ones it could: `--skip-checks` and a box with no `node_modules` on it are both
 * ordinary, and neither is a failure.
 */
function reportSummary(report, state, resolved, { verified, checks, checked, wroteDirectory }) {
    const made = checked ? checkLines(checks, report.width) : ['not made: --skip-checks was passed'];
    if (checked) {
        made.push('', 'These are reports, not gates. The front door, its certificate and the DNS record'
            + ' come after this, and `node src/admin.js doctor` asks all of them again once they are in place.');
    }
    report.note([
        columns(chosenPairs(state, resolved), report.width),
        '',
        columns(writtenPairs(state, resolved, wroteDirectory), report.width),
        '',
        made.join('\n'),
        '',
        columns(nextSteps(state, resolved), report.width),
    ].join('\n'), 'Crossbar setup');
    report.outro('Set up. `systemctl restart crossbar` when you are ready.');
}

// ── The command ─────────────────────────────────────────────────────────────────

/** The console's password is set by the command that owns the prompt, never by this process. */
const defaultSpawn = (command, args, options) => spawnSync(command, args, options).status;

/**
 * Ask, write, verify, and report. Answers everything it can and refuses only what it must, in the
 * order the questions are asked, with nothing written until every chosen mode is complete.
 *
 * `ask` is the prompt layer: a function `(message, fallback) -> answer`, or the prompter
 * `src/prompt.js` builds, which is that and a menu and a box and a spinner besides. Either way a
 * null means no terminal, and the answers then have to come from the flags or from `--answers`.
 * `check` false skips the probes at the end, which is what a caller with no network — or a test —
 * wants; the probes report rather than decide, so nothing they find changes the outcome or the
 * exit code.
 */
async function runSetup({
    dir = process.cwd(),
    answers = {},
    ask = null,
    log = console.log,
    check = true,
    generate = generateSecret,
    spawn = defaultSpawn,
    stunUrl = null,
    locals = hostAddresses(),
} = {}) {
    const state = readState(dir);
    const { asker, terminal } = askLayer(ask);
    const report = makeReport(terminal, log);
    report.intro(`Crossbar setup${state.hasEnv ? ' — this deployment already has a .env' : ''}`);
    const resolved = await collectAnswers({ answers, state, asker, terminal, report, generate });
    const env = composeEnv(state, resolved);

    const short = shortfall(resolved, env);
    if (short.length) {
        // A bug in the wizard rather than in the answers, and still nothing written: the composed
        // file is the thing that has to be complete, and this is the last moment to notice.
        throw new SetupRefusal(`Refusing before anything is written: ${short.join(', ')} would be empty`
            + ` for a mode being set up. Nothing was written.`);
    }
    // Checked before a byte is written, because this is the write that can close a front door.
    if (resolved.directory) {
        try {
            directoryFile.validate(resolved.directory, { requireLogins: resolved.requireLogins });
        } catch (error) {
            throw new SetupRefusal(`Refusing before anything is written: the directory is not usable — ${String(error && error.message)}`);
        }
    }

    const writing = terminal ? terminal.spinner() : null;
    if (writing) writing.start(`Writing ${state.envPath}`);
    let verified;
    try {
        verified = writeDeployment({ state, resolved, env });
        if (writing) writing.stop(`${state.envPath}, and it loads`);
    } catch (error) {
        if (writing) writing.stop('nothing was written');
        throw error;
    }

    let checks = [];
    if (check) {
        const probing = terminal ? terminal.spinner() : null;
        if (probing) probing.start('Checking what this box looks like from outside');
        checks = await runChecks({ state, resolved, stunUrl, locals });
        if (probing) probing.stop('the checks are in the summary below');
    }

    if (resolved.password) {
        if (spawn && ask) {
            report.note('It is asked for and hashed by the command that owns the prompt, and never'
                + ' passes through this one.', 'The console password');
            const status = spawn(process.execPath, [path.join(__dirname, 'admin.js'), 'password'], { cwd: state.dir, stdio: 'inherit' });
            if (status !== 0) report.note('Run `node src/admin.js password` when you are ready.', 'The password was not set');
        } else {
            report.note('Setting it asks a person for something, and there is no terminal here.'
                + ' Run `node src/admin.js password`.', 'The console password was not set');
        }
    }

    reportSummary(report, state, resolved, {
        verified,
        checks,
        checked: check,
        wroteDirectory: Boolean(resolved.directory),
    });

    return {
        envPath: state.envPath,
        directoryPath: state.directoryPath,
        inForce: resolved.inForce,
        modes: resolved.modes,
        secrets: { sessionFrom: resolved.secrets.sessionFrom, turnFrom: resolved.secrets.turnFrom },
        verify: verified,
        checks,
    };
}

module.exports = {
    runSetup,
    SetupRefusal,
    answersFromOptions,
    makeTerminal,
    readState,
    natVerdict,
    hostnameVerdict,
    hostAddresses,
    generateSecret,
    parsePeople,
    parsePersonLine,
};
