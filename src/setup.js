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
    writeEnvFile, writtenMode, ENV_KEYS, environmentKeys,
} = require('./config');
const directoryFile = require('./directory');
const prompts = require('./prompt');
// The relay's own client, for the one request that obtains this deployment's installation. It
// requires nothing but `node:crypto`, so this does not disturb the rule that nothing here loads
// a dependency — `install.sh` runs this wizard before `npm ci`.
const { enrolInstallation } = require('./pushrelay');

/** The default `loadConfig` falls back to, so the probe reports on the server the same address. */
const DEFAULT_STUN = 'stun:stun.l.google.com:19302';

/** As long as a local command deserves: `tailscale status` answers from the daemon or not at all. */
const TAILSCALE_TIMEOUT_MS = 4000;

/** A refusal this wizard makes before it writes anything, as a sentence for the operator. */
class SetupRefusal extends Error {}

/** 32 bytes of hex — what the runbook's `openssl rand -hex 32` produced, from `node:crypto`. */
const SECRET_BYTES = 32;

function generateSecret() {
    return crypto.randomBytes(SECRET_BYTES).toString('hex');
}

/**
 * The environment a command this wizard starts gets: everything this process has, minus every
 * name this deployment reads out of `.env`.
 *
 * The wizard runs as the deployment's account in a shell a person is logged into, and every
 * command it starts — `admin.js password`, `admin.js enroll` — inherits that shell. A name the
 * shell happens to carry (an empty `NETWORK_MODE_PRIVATE_ORIGIN=`, a value exported for something
 * else) then beats the file the wizard just wrote, and the child reads the shell rather than the
 * deployment. Removing the names lets the child load `.env` fresh, which is exactly what the
 * service does through `EnvironmentFile`; what is left — `PATH`, `HOME`, `TS_AUTHKEY` — is what a
 * child genuinely needs from here.
 */
function childEnv(environment = process.env) {
    const env = { ...environment };
    for (const name of ENV_KEYS) delete env[name];
    return env;
}

/**
 * The tailnet name this machine is already reachable at, or `''` — `tailscale status --json`'s
 * `Self.DNSName` with the trailing dot dropped, which is the same value the front door will serve
 * and the same one `diagnostics`' private check reasons about.
 *
 * Empty is an ordinary answer, not a failure: Tailscale may not be installed, may not be running,
 * or the daemon may not be logged in yet — the wizard runs before the installer's front-door phase
 * on a fresh host, so on a first install there is usually nothing to ask. The question's own
 * wording says what the field is for in that case, which is why this returns a value rather than
 * throwing. `command` is the injectable seam, as in `checkTailscale`: a test hands it a fixture
 * and a real run leaves it as `tailscale` on `PATH`.
 */
function tailnetName(command = 'tailscale') {
    const result = spawnSync(command, ['status', '--json'], {
        encoding: 'utf8', timeout: TAILSCALE_TIMEOUT_MS, env: childEnv(),
    });
    if (result.error || result.status !== 0 || !result.stdout) return '';
    try {
        const dnsName = JSON.parse(result.stdout)?.Self?.DNSName;
        return dnsName ? String(dnsName).replace(/\.$/, '') : '';
    } catch {
        // A daemon that answered something other than JSON has not answered this question.
        return '';
    }
}

/**
 * The name the login gives this machine in the tailnet — the first label of the address an
 * invitation carries, which is why `install.sh` defaults it to the deployment's own name rather
 * than letting the host keep the one its provider assigned it. The installer's choice arrives in
 * `TAILSCALE_HOSTNAME` (`--tailscale-hostname` overrides it, and it is validated there); a run of
 * `setup` nobody wrapped derives the same default from the deployment's own directory name,
 * reduced to a DNS label for the reason `deployment_tailscale_hostname` reduces it: a directory
 * name is not a hostname, and `My_Box.v2` is a name Tailscale cannot answer at.
 */
function tailnetHostname(dir) {
    const spelled = String(process.env.TAILSCALE_HOSTNAME || '').trim();
    if (spelled) return spelled;
    const label = path.basename(path.resolve(dir)).toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .slice(0, 63)
        .replace(/-+$/, '');
    return label || 'crossbar';
}

/**
 * What is left when this machine could not be joined from here: the one command, what it does, and
 * that the installer finishes the job by itself on the next run. Short rather than a reference to
 * deploy/README.md §2.8.1 — the person reading it is mid-install, and the address this run is about
 * to write is the one the command makes true.
 */
const tailnetJoinInstructions = (hostname, lead) => [
    lead,
    '',
    `    tailscale up --hostname ${hostname}`,
    'It prints a link; approving this machine there gives it a tailnet name.',
    'A tailnet name is the name this machine is known by in your Tailscale network.',
    'Then re-run this install and the private address is set from that name',
    'rather than typed.',
].join('\n');

/**
 * Join this machine to the tailnet, here, before the address that depends on it is asked for.
 *
 * This is the difference between asking a person for the private address and knowing it. That
 * address is the name Tailscale gives this machine; the machine can be joined from the same
 * process that is about to ask the question, because that process runs as the deployment's account
 * and `install.sh` has already named that account the daemon's operator (and started the daemon);
 * and `tailscale up` is the whole of the joining — it prints a link and waits for the approval
 * that gives the machine its name. So it is run here, in the foreground, where the link and the
 * person both are, and the name is read back afterwards to offer as the answer.
 *
 * It runs when there is a terminal to show the link in, and — since a key needs no approval —
 * whenever a key was carried, which is what `--tailscale-authkey` buys an unattended install. With
 * neither it is not attempted: there would be nobody to approve the machine and no name to read
 * back, so the address is asked for and the instructions to join go with the question.
 *
 * Nothing here fails the run. A machine that cannot be joined is an ordinary state — a fresh host,
 * a declined link, a tailnet that is not up — and the wizard is the wrong place to stop over it:
 * `install.sh`'s front door makes the same attempt again at the end of the install, with the
 * install's own instructions. What this returns is the name if there is one now, and `''` if not,
 * which is what the private address is derived from.
 */
function joinTailnet({ command, dir, report, terminal, authkey, spawn }) {
    const before = String(tailnetName(command) || '');
    if (before) {
        report.note(`This machine is already on your tailnet as ${before}. The private address below`
            + ' is that name, so Enter keeps it.', 'Tailscale');
        return before;
    }
    const hostname = tailnetHostname(dir);
    if (!spawn || (!terminal && !authkey)) {
        report.note(tailnetJoinInstructions(hostname,
            'This machine is not on your tailnet yet, and there is nowhere here to show the link'
            + ' its login prints: this machine has to be joined from a terminal, or with a key.'
            + ' The private address below has to be typed from what you expect it to be.'),
        'Tailscale');
        return '';
    }
    // In the foreground, on this terminal, so Tailscale's own link is what the person reads — and
    // with the key in the environment, which is where `tailscale up` reads it from, so it appears
    // in neither the process list nor the transcript.
    const options = authkey
        ? { stdio: 'inherit', env: { ...childEnv(), TS_AUTHKEY: authkey } }
        : { stdio: 'inherit', env: childEnv() };
    const status = spawn(command, ['up', '--hostname', hostname], options);
    const after = String(tailnetName(command) || '');
    if (status === 0 && after) {
        report.note(`This machine joined your tailnet as ${after}. The private address below is that`
            + ' name, so Enter keeps it.', 'Tailscale');
        return after;
    }
    report.note(tailnetJoinInstructions(hostname,
        'The login was run here and did not finish — declined, or it timed out — so this machine'
        + ' still has no tailnet name and the private address below has to be typed from what you'
        + ' expect it to be.'), 'Tailscale');
    return after;
}

// ── The answers, from flags and from a file ─────────────────────────────────────
//
// One vocabulary for both, so the two cannot drift apart: a key, the flag that sets it, and the
// JSON name in an `--answers` file are the same word.

/** Every answer this wizard reads, in the order the questions are asked. */
const ANSWER_KEYS = Object.freeze([
    'approach',
    'mode', 'inForce',
    'privateHostname', 'privateOrigin',
    'publicHostname', 'publicOrigin', 'publicBindAddress',
    'people', 'directory',
    'turnHost', 'turnSecret',
    'pushRelay', 'pushRelayUrl', 'pushRelayToken', 'pushRelayInstallationId',
    'sessionSecret', 'newSecrets', 'password', 'invite',
]);

/**
 * The relay a phone is rung through when nobody names one of their own. A deployment that accepts
 * this default **enrols with it**: the wizard posts to its `/v1/installations` route and writes
 * the three settings it answers with, so nobody types a credential and nobody runs a command
 * afterwards. Which relay ended up in force is named in the summary — a stranger must not
 * inherit somebody else's relay without being told.
 */
const DEFAULT_PUSH_RELAY_URL = 'https://crossbar-push-dev.ibnfaisalc.workers.dev';

/** The three names that decide which relay this deployment rings through (`src/pushrelay.js`). */
const PUSH_RELAY_KEYS = Object.freeze([
    'CROSSBAR_PUSH_RELAY_URL', 'CROSSBAR_PUSH_RELAY_TOKEN', 'CROSSBAR_PUSH_RELAY_INSTALLATION_ID',
]);

/**
 * The three ways a deployment can be given a push relay, in the order the menu offers them:
 * the shared relay enrolled here, a relay somebody names, or none.
 *
 * `standard` is the default because it is the one that leaves nothing to type and nothing to
 * run: the wizard obtains this deployment's own installation from the shared relay and writes
 * its three settings. `another` is for a relay the operator runs, or one whose credential they
 * were handed. `none` is for a deployment that does not want push — a phone whose screen is off
 * simply is not rung.
 */
const PUSH_RELAY_CHOICES = Object.freeze(['standard', 'another', 'none']);

/**
 * The question, and what each answer costs. One line, like every other question here: what a
 * relay is and why a locked phone needs one lives in `deploy/README.md` §2.7.1, and the summary
 * is where the consequence of picking `none` is read.
 */
const PUSH_RELAY_QUESTION = 'How should a locked phone be rung?';

const PUSH_RELAY_OPTIONS = Object.freeze([
    { value: 'standard', label: 'The shared relay', hint: 'enrols this deployment automatically — nothing to type or run' },
    { value: 'another', label: 'Another relay', hint: 'a relay you run, or one whose credential you were given' },
    { value: 'none', label: 'No relay', hint: 'a phone whose screen is off cannot be rung' },
]);

/** `standard`, `another` or `none` — refusing anything else by name. */
function parsePushRelayChoice(value) {
    const wanted = String(value ?? '').trim().toLowerCase();
    if (PUSH_RELAY_CHOICES.includes(wanted)) return wanted;
    throw new SetupRefusal(`"${value}" is not a push relay choice: --push-relay takes`
        + ' standard (the shared relay, enrolled here), another (one you name), or none.');
}

/**
 * The label the shared relay records for this installation, which its operator reads and nobody
 * else does: this deployment's own address is the name they would recognise it by. A hostname is
 * already inside the relay's bound, and `os.hostname()` is the fallback for a run that somehow
 * names no address.
 */
function relayLabel(blocks, inForce) {
    const host = blocks?.[inForce]?.HOSTNAME || blocks?.public?.HOSTNAME || blocks?.private?.HOSTNAME || '';
    return String(host || os.hostname() || '').trim();
}

/**
 * What a refused enrolment says, in one sentence, to somebody in the middle of an install.
 *
 * Deliberately not the relay's error code. `enrolment_closed` and `rate_limited` are two things a
 * person cannot act on and two codes they cannot read, and they mean opposite things about
 * retrying — one will never succeed, the other might. What matters to the person is what happened
 * and that this deployment is still installable, so the code stays in the relay's own logs and
 * this is the sentence that reaches the screen.
 *
 * An answer that was never received is said as *unknown* rather than failed, because the route
 * takes no idempotency key: an installation may have been created whose credential nobody holds,
 * and nothing here sends the request a second time (relay `docs/API.md`).
 */
function pushRelayRefusal(outcome) {
    switch (outcome.reason) {
        case 'enrolment_closed':
            return 'The shared relay is not taking new installations — it has reached the number its'
                + ' operator allows — so nothing was created.';
        case 'rate_limited':
            return 'The shared relay is limiting how often installations can be created, so nothing was'
                + ' created'
                + (outcome.retryAfterSeconds
                    ? `; it asks for about ${outcome.retryAfterSeconds} more seconds before another try.`
                    : '.');
        case 'unreachable':
            return 'The shared relay did not answer, so whether an installation was created is unknown;'
                + ' its enrolment request cannot be repeated, so this install will not send it again.';
        default:
            return 'The shared relay refused to create an installation, and nothing was created.';
    }
}

/** The other half of a refusal: what still works, and the door that is still open. */
const PUSH_RELAY_FALLBACK = 'This deployment can still be installed: name a relay you already have, or'
    + ' carry on without one — calls still work, but a phone whose screen is off will not be rung.';

/** The two ways a run can be walked: three questions with the rest derived, or every setting asked. */
const APPROACHES = Object.freeze(['basic', 'advanced']);

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
    const template = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : '';
    const hasEnv = fs.existsSync(envPath);
    const content = hasEnv ? fs.readFileSync(envPath, 'utf8') : template;
    // `install.sh` seeds `.env` by copying `.env.example` a moment before this runs, so an `.env`
    // byte-for-byte equal to the template is an unconfigured deployment rather than a re-run of
    // something. The intro says which, because "this deployment already has a .env" on a first
    // install reads like a second one.
    const seeded = hasEnv && template !== '' && content === template;
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
        seeded,
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
        pushRelay: {
            url: settingIn(content, 'CROSSBAR_PUSH_RELAY_URL'),
            // Read for two things: the summary says whether a relay named there can actually
            // ring, because a URL with no token is a transport that stays disabled, and a
            // re-run keeps a credential already enrolled rather than minting a second
            // installation whose first credential nobody holds. It is never printed.
            token: settingIn(content, 'CROSSBAR_PUSH_RELAY_TOKEN'),
            installationId: settingIn(content, 'CROSSBAR_PUSH_RELAY_INSTALLATION_ID'),
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
        {
            key: 'privateHostname',
            name: 'HOSTNAME',
            prompt: 'the address people dial over the tailnet',
            // Asked only when Tailscale answered with this machine's own name, which is the case the
            // join above exists for: then there is nothing to guess and the field already holds the
            // address, so the question says what the value is rather than what it is for. That is
            // the whole of "shown as a derived value to confirm" — the answer is offered, and Enter
            // keeping it is the confirmation.
            settled: 'the address people dial over the tailnet — this machine is on your tailnet already,'
                + ' so the field holds the name it answers at',
        },
        {
            key: 'privateOrigin',
            name: 'ORIGIN',
            prompt: 'the web address an invitation opens',
        },
    ]),
    public: Object.freeze([
        {
            key: 'publicHostname',
            name: 'HOSTNAME',
            prompt: 'the address people reach this deployment at',
        },
        {
            key: 'publicOrigin',
            name: 'ORIGIN',
            prompt: 'the web address an invitation opens',
        },
        {
            key: 'publicBindAddress',
            name: 'BIND_ADDRESS',
            // The one answer here that is a fact about this machine rather than about a name, and the
            // one the machine can list: `ownAddressClause` puts this host's own addresses in the
            // question. No default is invented from them — which of them the router forwards to is
            // not knowable from inside — but it is not left for a person to look up either.
            prompt: 'the local address the web front end (Caddy) listens on',
        },
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
    return `${modeLabel(mode)} cannot bind ${address}. Name the one address this server is reached at`
        + ' — 0.0.0.0 is every address, including the one tailscaled already holds in public mode, so'
        + ' Caddy never takes the port and never obtains a certificate: what you would see is a TLS'
        + ' failure about a hostname that is configured correctly.';
}

/**
 * The choice that decides how much of the wizard a person meets: three questions with everything
 * else worked out, or every setting with a value suggested. It is asked first, so a person who
 * wants the short path is not walked through the long one to find it.
 *
 * The labels carry what each one asks, because the words "basic" and "advanced" on their own say
 * nothing about what is left out of the first — and the reasoning for everything the short path
 * derives lives in `deploy/README.md` (§2.2.1), which is where a person who wants to know *why*
 * is sent.
 */
const APPROACH_QUESTION = 'Basic setup, or advanced?';
const APPROACH_OPTIONS = Object.freeze([
    { value: 'basic', label: 'Basic', hint: 'modes, people and the console password — the rest is worked out' },
    { value: 'advanced', label: 'Advanced', hint: 'every setting, each with a suggested value' },
]);

/**
 * The one question that decides every other one, as a menu and as a line.
 *
 * Short by design: the labels and their hints are what say what each mode is, and the long reading
 * of Tailscale — a private network between your own devices — is in `deploy/README.md` (§2.2.1)
 * rather than in front of a question. The labels keep the name, because the mode that needs
 * Tailscale cannot be chosen by somebody who has not met the word, and the hint is the one line
 * that says what it means.
 */
const MODE_QUESTION = 'How will people reach this deployment?';

/** The three answers `--mode` takes, as the menu they are chosen from, with what each one costs. */
const MODE_OPTIONS = Object.freeze([
    { value: 'private', label: 'Tailscale only (private)', hint: 'your own devices, from anywhere — and nothing else reaches it' },
    { value: 'public', label: 'Open internet (public)', hint: 'needs a domain name that points here, and an open port' },
    { value: 'both', label: 'Both', hint: 'private now, public once its name points here' },
]);

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

/** `basic` or `advanced` — the one choice at the start, refusing anything else by name. */
function parseApproach(value) {
    const wanted = String(value ?? '').trim().toLowerCase();
    if (APPROACHES.includes(wanted)) return wanted;
    throw new SetupRefusal(`"${value}" is not an approach: --approach takes basic or advanced.`);
}

/**
 * The id a display name is known by: lower case, spaces turned into `-`, and nothing kept but
 * lower-case letters, digits and `-` — `O'Brien` becomes `obrien`, `Abdullah Al-Faisal` becomes
 * `abdullah-al-faisal`. A name that leaves nothing (punctuation only, or empty) derives nothing,
 * and the question is asked again rather than answered with an unusable id.
 *
 * It is one rule in one place because it is asked in four: the terminal, a plain line, an answers
 * file that names no id, and the browser page — and an id a person is known by that changed with
 * the front end would be a different person.
 *
 * The ends are trimmed and the result cut to the 64 characters `src/directory.js` accepts, because
 * `- Bob` and a 90-character name are both ids that file refuses — and this is the function that
 * decides what an id is.
 */
function shortIdFrom(name) {
    return String(name ?? '').toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64)
        .replace(/-+$/, '');
}

/** One person, as the line a person types and as the object an answers file holds. */
function parsePersonLine(line) {
    const [name, login, ...rest] = String(line).split(',').map((part) => part.trim());
    const id = shortIdFrom(name);
    if (!name || !id) {
        throw new SetupRefusal(`"${line}" is not a person. Write one as "display name, login, admin" —`
            + ' the id is taken from the display name, and the login and the administrator flag may be'
            + ' left blank.');
    }
    return { id, name, login: login || '', admin: rest.some((part) => /^(admin|yes|true|1)$/i.test(part)) };
}

/** The same person, as an answers file or `--people` may hold them. */
function normalizePerson(entry) {
    if (typeof entry === 'string') return parsePersonLine(entry);
    const name = String(entry?.name ?? entry?.displayName ?? '').trim();
    // An id in the answers is the one that wins — a script may name somebody whose display name
    // would derive something else — and a person named without one has it derived the same way the
    // terminal derives it.
    const id = String(entry?.id ?? '').trim() || shortIdFrom(name);
    if (!id || !name) {
        throw new SetupRefusal(`A person in --people needs a display name; "${JSON.stringify(entry)}" has`
            + ' none. One person is written as {"name": "Abdullah Al-Faisal", "login": "abdullah@dev",'
            + ' "admin": true} — the id is derived from the name unless it is given too. JSON, inside the'
            + ' array, or in a file named with @.');
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
 * One question names a person: their display name. The id everybody else knows them by is derived
 * from it (`shortIdFrom`) and **said back** in a note, so nobody has to guess what they will be
 * shown as — and the note is what makes it one question instead of the two it used to be, a short
 * id and a display name whose only difference was which one the app showed.
 *
 * `basic` leaves out the two questions a short run does not need: the first person administers the
 * directory (the default the long run offers anyway), and a login is asked only where the
 * deployment will need one (`needLogin`).
 *
 * An empty list is the answer "keep what is there": the caller reads it that way.
 */
async function askPeopleByFields(terminal, report, state, { basic = false, needLogin = false } = {}) {
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
        const name = await terminal.text({
            message: `${first ? 'The first person' : 'Another person'}: their display name`,
            validate: (value) => (shortIdFrom(value) ? undefined
                : 'A name is needed: it becomes the id everybody else knows them by.'),
        });
        const id = shortIdFrom(name);
        // The derived id, shown before the next question replaces this note: what they will be
        // known as is not something they should have to work out from the name they typed.
        report.note(`${name} will be known as ${id}.`, 'The person');
        const someone = { id, name, login: '', admin: first };
        // The login is optional in public mode and needed in private mode, where the tailnet names
        // the caller and a person without one cannot be found (§7). Said in one line now: the
        // question itself is short, and the reason the field matters is here and in the runbook.
        if (!basic || needLogin) {
            someone.login = await terminal.text({
                message: `${id}: their Tailscale login` + (needLogin ? '' : ' (blank if they have none)'),
            });
        }
        if (!basic) {
            someone.admin = await terminal.confirm({
                message: `${id}: an administrator?`,
                initialValue: first,
            });
        }
        people.push(someone);
        if (!await terminal.confirm({ message: 'Another person?', initialValue: false })) return people;
    }
}

/**
 * The people, one line each — the shape anything plainer than a terminal can be asked. A blank
 * line answers for the whole file: done when there is none yet, and "keep what is there" when
 * there is.
 *
 * The line is a display name first, because the id is derived from it here exactly as the terminal
 * derives it: a script and a person name a person the same way.
 */
async function askPeopleByLines(ask, report, state, { needLogin = false } = {}) {
    report.note(`One person per line, as "display name, login, admin", and a blank line to`
        + ` ${state.directory ? `keep the ${peopleCount(state.directory.users.length)} already there` : 'say you are done'}.`
        + ' The display name is what the line needs: the id everybody else knows them by is derived'
        + ' from it. The login is their Tailscale account, which'
        + `${needLogin ? ' this deployment needs (it is how a caller is found)' : ' is optional here'}, and`
        + ' "admin" makes them an administrator.', 'The directory');
    const people = [];
    for (;;) {
        const named = await ask('Person', '');
        if (!named) return people;
        people.push(parsePersonLine(named));
    }
}

/**
 * Decide which relay rings this deployment's phones, and obtain its credential if that is the
 * answer.
 *
 * Three answers, and the order they are looked for is the wizard's usual one: an answer, then what
 * the file already holds, then the terminal — and only a run that nothing decided takes the
 * default. That default is `standard`, the shared relay enrolled from here, because it is the one
 * that leaves nothing for a person to do afterwards: no credential to paste, no command to run.
 *
 * A relay the file already names is kept rather than replaced. Selecting `standard` over a
 * credential already in the file would mint a second installation and orphan the first, whose
 * credential nobody holds — so an already-enrolled standard relay is a no-op, and a custom one is
 * the default answer of the menu rather than something the run moves on its own.
 *
 * A refusal does not abort. The shared relay being full or busy says nothing about whether this
 * deployment can be installed, so the refusal is turned into a sentence, the manual path is
 * offered, and the run continues — with a relay that already worked if there is one, and with no
 * relay if the person declines. Nothing here throws: a stack trace in the middle of an install is
 * the failure this degrades away from.
 *
 * `fetchImpl` is the seam the tests reach the shared relay through; in a real run it is Node's own
 * `fetch`.
 */
async function choosePushRelay({ state, report, terminal, asker, approach, line, supplied, blocks, inForce, fetchImpl }) {
    const held = state.pushRelay;
    const given = supplied('pushRelay');
    let choice = null;
    if (given !== null) choice = parsePushRelayChoice(given);
    // A URL in the answers is somebody naming a relay, whether or not they also said the word.
    else if (supplied('pushRelayUrl') !== null) choice = 'another';
    else if (approach === 'advanced' && terminal) {
        // Asked whenever there is somebody to ask, with what the file holds as the answer Enter
        // takes: a relay already in the file is the default rather than something this run moves
        // on its own, and a fresh deployment gets the automatic path.
        choice = parsePushRelayChoice(await terminal.select({
            message: PUSH_RELAY_QUESTION,
            options: PUSH_RELAY_OPTIONS,
            initial: held.url ? 'another' : 'standard',
        }));
    } else if (approach === 'advanced' && asker) {
        const fallback = held.url ? 'another' : 'standard';
        const answer = await asker(`${PUSH_RELAY_QUESTION} (standard, another, or none)`, fallback);
        choice = parsePushRelayChoice(answer === '' || answer === undefined ? fallback : answer);
    } else if (held.url) {
        // No terminal to ask on, and a relay already in the file: keep it, and do not mint a second
        // installation whose first credential nobody holds.
        choice = 'another';
    } else {
        // The short run, a run with no terminal, and any run nothing answered: the automatic path.
        choice = 'standard';
    }

    if (choice === 'standard' && !(held.url === DEFAULT_PUSH_RELAY_URL && held.token)) {
        const outcome = await enrolInstallation({
            relayUrl: DEFAULT_PUSH_RELAY_URL,
            label: relayLabel(blocks, inForce),
            fetch: fetchImpl,
        });
        if (outcome.ok) {
            report.note(`This deployment is enrolled with ${outcome.relayUrl} as`
                + ` ${outcome.installationId}. The credential is in ${state.envPath} and is not shown`
                + ' here.', 'The push relay');
            return { url: outcome.relayUrl, token: outcome.credential, installationId: outcome.installationId, from: 'enrolled' };
        }
        const refusal = pushRelayRefusal(outcome);
        report.note(`${refusal} ${PUSH_RELAY_FALLBACK}`, 'The push relay');
        // Offered, not assumed: the manual path is a question where there is somebody to ask, and
        // keeping what already works is the answer where there is not.
        if (terminal
            ? Boolean(await terminal.confirm({ message: 'Name a relay you already have instead?', initialValue: Boolean(held.url) }))
            : Boolean(held.url && held.token)) {
            choice = 'another';
        } else if (held.url) {
            return { url: held.url, token: held.token, installationId: held.installationId, from: held.token ? 'kept' : 'none', refusal };
        } else {
            return { url: '', token: '', installationId: '', from: 'none', refusal };
        }
    } else if (choice === 'standard') {
        // Already enrolled here: nothing to obtain, and asking again would create a second
        // installation whose credential nobody holds.
        return { url: held.url, token: held.token, installationId: held.installationId, from: 'kept' };
    }

    if (choice === 'none') return { url: '', token: '', installationId: '', from: 'none' };

    // `another`: a relay the person names, and the credential they already have. Blank keeps what
    // the file holds, exactly as every other field here does.
    const url = String(await line({ key: 'pushRelayUrl', message: 'The push relay to use', held: held.url }));
    if (!url) return { url: '', token: '', installationId: '', from: 'none' };

    const tokenGiven = supplied('pushRelayToken');
    let token;
    if (tokenGiven !== null) token = String(tokenGiven);
    else if (terminal) {
        token = String(await terminal.text({
            message: 'Its installation credential',
            placeholder: held.token ? 'the one in the file' : '',
            defaultValue: held.token,
            // A server secret: the field shows that there is one and never what it is.
            hidden: true,
        }));
    } else if (asker) token = String(await asker('Its installation credential (blank keeps the one in the file)', held.token));
    else token = held.token;

    const idGiven = supplied('pushRelayInstallationId');
    const installationId = idGiven !== null ? String(idGiven) : (held.url === url ? held.installationId : '');
    return {
        url,
        token,
        installationId,
        from: tokenGiven !== null ? 'given' : (token && token === held.token ? 'kept' : (token ? 'given' : 'none')),
    };
}

/**
 * Ask every question, in order, and answer each one from the flags, the file, the terminal — or
 * refuse, naming what is missing.
 *
 * The rule throughout is: an answer, then what the deployment already holds, then the terminal.
 * Only a value that none of the three can produce is missing, which is what makes a second run
 * over a configured deployment a no-op and an unattended run of a file that does not exist a
 * refusal rather than a guess. A default is derived only where it changes nothing — the origin is
 * the hostname with `https://` in front, the mode in force is the mode the file already says, and
 * the private address is the tailnet name this machine already has (`tailnet` below), which the
 * deployment cannot invent for itself and does not have to be asked for.
 *
 * The one question that is not answered from those three is the first: **how much of this to
 * walk** (`approach`). It is a routing question rather than a value, so the flags do not answer
 * it, and a terminal is asked it whenever there is one; with no terminal it is `advanced`, because
 * a run that was not told to be short must not quietly derive. `basic` then fills in every address
 * this machine can work out for itself and leaves the questions that cannot be derived, while
 * `advanced` asks them all with their values offered.
 *
 * Where the questions go is two things, because they are not the same thing: `terminal` is the
 * prompter `src/prompt.js` builds, which draws a menu and a field and a confirmation, and `asker`
 * is a plain `(message, fallback) -> answer`, which can only ask a line at a time. `src/admin.js`
 * injects the first on a terminal; a script or a test injects the second, and the questions the
 * prompter would have drawn are then asked as lines — the same questions, and the same answers
 * written from them. `report` is wherever the wizard is allowed to say something, which is the
 * same prompter, or `src/prompt.js`'s frames written plainly into the log.
 *
 * `tailscale` is the command the tailnet is read and joined through, `''` to skip both — the same
 * injectable seam `runSetup` takes, so a test needs no Tailscale. `authkey` joins the machine
 * without anybody approving it, and `spawn` is what runs the login. The join is attempted only for
 * a mode set that includes private, and only where it can be answered, so a public-only run never
 * spawns Tailscale at all and neither does one that cannot be joined from here. `locals` is this
 * host's own addresses, which is what the public bind address is a choice among — `runSetup`
 * reads them once, so the question and the checks reason about the same list. `fetch` is what the
 * push relay's enrolment request is made through, defaulting to Node's own `fetch`.
 */
async function collectAnswers({ answers, state, asker, terminal, report, generate, tailscale = '', authkey = '', spawn = null, locals = [], fetch: fetchImpl = globalThis.fetch }) {
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

    // 1. How much of the wizard to walk, and then which modes. The approach is asked first and is
    //    a line of its own, so the short path is chosen rather than discovered; with no terminal it
    //    is `advanced` unless an answer says otherwise, because the long path asks for every value
    //    and derives none of them — a run that was not told to be short must not be.
    const approachGiven = supplied('approach');
    const approach = approachGiven !== null
        ? parseApproach(approachGiven)
        : (terminal
            ? parseApproach(await terminal.select({
                message: APPROACH_QUESTION,
                options: APPROACH_OPTIONS,
                // A fresh deployment is the short path's case; a file that already names a mode is
                // a re-run, where the long path's offered defaults are what "change nothing" means.
                initial: state.written ? 'advanced' : 'basic',
            }))
            : 'advanced');

    // 2. Which modes. Nothing is complete until this is answered, and it decides every question
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

    // Which of the chosen modes is in force, decided here because the people questions read it: it
    // is not a question — the file already answers it, and when the file says nothing the answer is
    // the default `loadConfig` uses, so writing it down changes nothing about which mode is in
    // force.
    const inForceAnswer = supplied('inForce');
    const derivedInForce = state.written && modes.includes(state.written)
        ? state.written
        : (modes.includes('private') ? 'private' : 'public');
    const inForce = String(inForceAnswer ?? derivedInForce);
    if (!modes.includes(inForce)) {
        throw new SetupRefusal(`--in-force is ${inForce}, which is not one of the modes being set up (${modes.join(', ')}).`);
    }
    const requireLogins = inForce === 'private';

    // 3. The tailnet, before the address that names it. The private address is this machine's own
    //    tailnet name, and a machine with no name has to be asked blind — so the joining happens
    //    here, where the mode is known and the person is looking, and the name it produces is what
    //    the question below offers. Nothing when the mode set cannot include a private address:
    //    Tailscale is not spawned for a public-only deployment, and this is the only place in the
    //    wizard that runs it as anything but a read.
    let joinedName = '';
    if (modes.includes('private') && tailscale) {
        joinedName = joinTailnet({ command: tailscale, dir: state.dir, report, terminal, authkey, spawn });
    }

    // 4. The addresses each chosen mode is reached at.
    //
    //    The long run asks each one, with what the deployment already holds — or what the tailnet
    //    name above makes true — offered as the value Enter takes. The short run fills in what this
    //    machine can work out for itself: the tailnet name the join read back, an origin that is a
    //    hostname with `https://` in front, and the address this host holds that a router could
    //    forward to. The one address no machine can know is a public name somebody owns, so the
    //    short run asks for exactly that and nothing else.
    const blocks = Object.fromEntries(MODES.map((mode) => [mode, { HOSTNAME: '', ORIGIN: '', BIND_ADDRESS: '' }]));
    for (const mode of modes) {
        for (const question of ADDRESS_QUESTIONS[mode]) {
            const stored = state.block[mode][question.name];
            // The name the tailnet gave the machine above is the private address — it is what an
            // invitation carries, and the login is what made it true — so it is what the field
            // holds, in place of a value `.env` was given before the machine had a name at all.
            // The origin follows it, because the two are one address in two spellings. Nothing is
            // answered *for* the person: the value is offered, and Enter keeping it is the
            // confirmation. `''` when Tailscale answered nothing, which is what leaves today's
            // question — and today's reading of `.env` — exactly as they were.
            const known = mode === 'private' ? joinedName : '';
            const held = known ? '' : stored;
            const derived = known
                ? (question.name === 'ORIGIN' ? `https://${known}` : known)
                : (question.name === 'ORIGIN'
                    ? (blocks[mode].HOSTNAME ? `https://${blocks[mode].HOSTNAME}` : '')
                    : '');
            const bindProblem = question.name === 'BIND_ADDRESS' ? (address) => bindAddressProblem(mode, address) : null;
            const asking = {
                key: question.key,
                message: `${modeLabel(mode)}: ${known && question.settled ? question.settled : question.prompt}`
                    + ownAddressClause(question.name, locals),
                held: held || derived,
                validate: bindProblem,
            };
            // What the short run can fill in without asking: only an address it can work out, and
            // never a public name, which is a fact about a domain and not about this machine. An
            // answer from a flag or a file still wins over the derivation, the same as everywhere
            // else — the short run fills in what nothing supplied, it does not overrule.
            const given = supplied(question.key);
            const worked = given === null ? (derived || (question.name === 'BIND_ADDRESS' ? ownBindAddress(locals) : '')) : '';
            const value = approach === 'basic' && worked
                ? worked
                : (requiredIn(mode).includes(question.name) ? await needed(asking) : await line(asking));
            // The wildcard is refused wherever it came from: the field refuses it while it is
            // being typed, and this catches the same address arriving by flag or by answers file.
            const refused = bindProblem ? bindProblem(value) : null;
            if (refused) throw new SetupRefusal(refused);
            blocks[mode][question.name] = value;
        }
    }

    // 4. The directory of people, their logins, and who administers. A directory file already in
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
                ? await askPeopleByFields(terminal, report, state, { basic: approach === 'basic', needLogin: requireLogins })
                : await askPeopleByLines(asker, report, state, { needLogin: requireLogins });
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

    // 5. The relay, and the relay that rings a phone. The call relay is one question — "somewhere
    //    else?" — before a hostname is ever typed, because a relay this server can run is the
    //    default and there is nothing else to say about it. The push relay is the three-way choice
    //    above, whose default obtains this deployment's own installation from the shared relay.
    //
    //    The long run asks both; the short run derives the call relay and takes the automatic push
    //    path without asking. A relay the file already names is never overwritten by a run that was
    //    not told to change it, which is what keeps a second `setup` from moving a working relay.
    const ownRelay = ownRelayHost(blocks);
    const turnHostGiven = supplied('turnHost');
    let turnHost;
    if (turnHostGiven !== null) {
        turnHost = String(turnHostGiven);
    } else if (approach === 'advanced' && terminal) {
        // Defaulted to "no" when the file names this server's own address or names nothing: then
        // there is nothing else to say, and Enter keeps the relay on this box.
        const elsewhere = await terminal.confirm({
            message: 'Relay calls somewhere other than this server?',
            initialValue: Boolean(state.turnHost && state.turnHost !== ownRelay),
        });
        turnHost = elsewhere
            ? await line({
                key: 'turnHost',
                message: 'The relay\'s hostname',
                held: state.turnHost && state.turnHost !== ownRelay ? state.turnHost : '',
            })
            : ownRelay;
    } else {
        // No terminal to ask on: the file's own relay, or this server's address. A blank at the
        // hostname above is the one way to ask for no relay at all, and the summary says what that
        // costs: calls still connect, but some networks fail.
        turnHost = String(state.turnHost || ownRelay);
    }
    //    The push relay is one menu with three answers rather than a URL with a default, and the
    //    default is the automatic path: the shared relay is asked for this deployment's own
    //    installation, so nobody pastes a credential and nobody runs a command afterwards. The
    //    short run does not ask — it takes the automatic path — and a relay the file already names
    //    is kept rather than replaced (`choosePushRelay`).
    const pushRelay = await choosePushRelay({
        state, report, terminal, asker, approach, line, supplied, blocks, inForce, fetchImpl,
    });

    // 6. What can be generated. A secret the file already holds is kept, because replacing the
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

    if (misses.length) throw new SetupRefusal(noTerminalMessage(misses, Boolean(asker || terminal)));

    return {
        approach,
        modes,
        inForce,
        blocks,
        directory,
        // Logins are how somebody is found where the tailnet names the caller, which is what
        // `src/api.js` decides the same question from (`config.trustTailscaleHeaders`): required
        // in private mode, a record of who somebody is elsewhere in public mode.
        requireLogins,
        turnHost,
        pushRelay,
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
        ? 'setup could not finish: nothing was answered for these, and a mode cannot be written without them.'
        : 'setup has no terminal to ask on, and no answer for these:';
    const lines = misses.map((key) => `  ${flagName(key).padEnd(24)}${answerHelp(key)}`);
    return [header, ...lines, 'Nothing was written. Pass them as flags, or write them into a file and',
        'pass --answers <file>. `node src/admin.js setup --help` lists every answer.'].join('\n');
}

/** What one missing answer is for, in the refusal above. */
function answerHelp(key) {
    return {
        mode: 'how people reach this deployment: private (Tailscale), public (open internet), or both',
        privateHostname: 'the address your people\'s phones dial over the tailnet, e.g. crossbar.tailnet-name.ts.net',
        privateOrigin: 'the web address an invitation opens, e.g. https://crossbar.tailnet-name.ts.net',
        publicHostname: 'the public name people reach this deployment at, e.g. calls.example.com',
        publicOrigin: 'the web address an invitation opens, e.g. https://calls.example.com',
        publicBindAddress: 'this server\'s own address that Caddy listens on, never 0.0.0.0, e.g. 203.0.113.10',
        people: 'the directory: a JSON array of { name, login, admin } — the id is derived from the name — or @file naming one',
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
    // The relay a phone is rung through, and the three settings that decide it, written together
    // because they are one thing: the relay's address, the credential the wizard either enrolled
    // here or was given, and the relay's id for this installation. A blank choice writes all three
    // empty rather than leaving a credential for a relay the deployment no longer uses.
    content = setEnvLine(content, 'CROSSBAR_PUSH_RELAY_URL', resolved.pushRelay.url);
    content = setEnvLine(content, 'CROSSBAR_PUSH_RELAY_TOKEN', resolved.pushRelay.token);
    content = setEnvLine(content, 'CROSSBAR_PUSH_RELAY_INSTALLATION_ID', resolved.pushRelay.installationId);
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
 * This host's own addresses, as a clause on the one question whose answer is one of them.
 *
 * The public bind address is a fact about the machine and nothing else in the deployment can
 * supply it, so the question shows what this box can be bound at rather than sending a person to
 * look it up — the same move the private address makes by reading the tailnet name back. What it
 * does *not* do is choose: which of these the router forwards 443 to is not knowable from inside,
 * so none of them is offered as a default, and the field stays empty until one is named.
 *
 * What is listed is only what could be that answer. A link-local address is reachable from one
 * link and a browser cannot even be handed one without a scope id (the reading `src/setup-page.js`
 * makes of them, for the same reason); a 100.64/10 address is the tailnet's — where Tailscale
 * listens, not where a router forwards, and the wildcard refusal exists because of what
 * tailscaled already holds there; and IPv6 is left out rather than guessed at, because the name
 * this deployment serves is reached over IPv4 (§8.3).
 */
function ownAddressClause(name, locals) {
    if (name !== 'BIND_ADDRESS') return '';
    const own = ownAddresses(locals);
    return own.length ? ` — this host's own IPv4 addresses: ${own.join(', ')}` : '';
}

/**
 * The addresses the clause above lists — and the list the short run chooses from, so that what is
 * shown and what is derived are the same set. Link-local, loopback, the tailnet's own range and
 * IPv6 are left out for the reasons above: none of them is where a router forwards 443.
 */
function ownAddresses(locals) {
    return (locals || []).map(String).filter((address) => !address.includes(':')
        && !/^(127\.|169\.254\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)/.test(address));
}

/**
 * The address the short run binds Caddy to, or `''` when there is no single answer to pick.
 *
 * The long run does not choose — which of these the router forwards 443 to is not knowable from
 * inside, so it shows them and lets a person say. The short run has to choose something, so it
 * prefers an address the internet could reach, which is the one a domain name would point at, and
 * falls back to the first candidate. `''` leaves the question to be asked: a box whose only
 * addresses are loopback, link-local or tailnet has nothing this could honestly fill in.
 */
function ownBindAddress(locals) {
    const own = ownAddresses(locals);
    const reachable = own.find((address) => !NOT_PUBLIC.test(address));
    return reachable || own[0] || '';
}

/** The address a relay on this server is reached at: its public name, else its tailnet name. */
const ownRelayHost = (blocks) => blocks.public?.HOSTNAME || blocks.private?.HOSTNAME || '';

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
            // The front door is installed *after* the wizard (`onboard_deployment`), and Caddy is
            // started by the shaper unit on the restart after that — so this run asks the question
            // before anything could answer it. A name that is not serving yet is therefore the
            // expected state of a first install rather than a fault, and it reads with the quiet
            // mark; `■` is kept for the checks that are wrong with the file this run wrote.
            return { verdict: result.ok ? 'ok' : 'pending', detail: result.detail };
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

/**
 * How a check reads in the summary: what could be made, and what could not.
 *
 * `pending` and `unknown` share the quiet ring deliberately: one is a check that cannot be made
 * *here* and the other a check that cannot be made *yet*, and neither is a fault. The filled
 * square is for the checks that are wrong with the deployment as it stands.
 */
const CHECK_MARK = Object.freeze({
    ok: prompts.SYMBOL.submitted,
    warn: prompts.SYMBOL.refused,
    unknown: prompts.SYMBOL.quiet,
    pending: prompts.SYMBOL.quiet,
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
    // The ids are named here as well as at the question, because the id is derived from a display
    // name and this box is where a person reads what they got: somebody who typed a name and
    // looked away should be able to see what they are known as without re-running anything.
    pairs.push(['Directory', `${peopleCount(people.length)}, ${administrators}`
        + ` administrator${administrators === 1 ? '' : 's'}`
        + (people.length ? ` — ${people.map((user) => user.id).join(', ')}` : '')]);
    // The relay's blank reading gives the same consequence the question did: the summary is where
    // a person reads what skipping it cost, and it is where "some networks will fail" belongs now
    // that the question itself is one line.
    pairs.push(['Relay', resolved.turnHost
        ? `${resolved.turnHost} · shared secret ${secretWord(resolved.secrets.turnFrom)}`
        : 'not configured — calls still work, but some networks will fail']);
    // The relay a phone is rung through, named because it is not this deployment's: a stranger must
    // not inherit somebody else's relay without being told which one it is. How the credential
    // arrived is said too — obtained automatically from the shared relay, given, or kept from the
    // file — because that is the difference between this install having done the work and it being
    // left for a person. The three names are printed beside whichever relay is in force, so what
    // would point the deployment at another one is where the relay it uses is read.
    const push = resolved.pushRelay;
    const credentialWord = {
        enrolled: 'credential obtained automatically',
        kept: 'credential kept from the file',
        given: 'credential given',
    }[push.from];
    let pushReading;
    if (!push.url) {
        pushReading = push.refusal
            ? `not configured — ${push.refusal} A phone whose screen is off cannot be rung.`
            : 'not configured — a phone whose screen is off cannot be rung';
    } else if (credentialWord) {
        pushReading = `${push.url} · ${credentialWord} · change it with ${PUSH_RELAY_KEYS.join(', ')}`;
    } else {
        pushReading = `${push.url} · no credential yet, so nothing rings until`
            + ' CROSSBAR_PUSH_RELAY_TOKEN is set';
    }
    pairs.push(['Push relay', pushReading]);
    // "session" is the one secret whose purpose a name cannot carry, and the one whose replacement
    // signs every device out (`--new-secrets`): said here, where the value is reported.
    pairs.push(['Secrets', `session (what signs a device in) ${secretWord(resolved.secrets.sessionFrom)}`
        + `${resolved.turnHost ? ` · relay ${secretWord(resolved.secrets.turnFrom)}` : ''}`]);
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

/**
 * What is left for a person after the run: the restart, and whichever of the two interactive
 * steps did not happen — it was answered no, or there was no terminal to ask. A step that ran is
 * not repeated here; `install.sh` still prints its own list after this.
 */
function nextSteps(state, resolved, done) {
    const admins = (resolved.directory?.users || state.directory?.users || [])
        .filter((user) => user.admin && user.enabled !== false);
    const steps = [['Then', 'systemctl restart crossbar']];
    if (!done.password) steps.push(['', 'node src/admin.js password   # the console\'s password, at /admin']);
    if (!done.invite) steps.push(['', `node src/admin.js enroll --user ${admins[0] ? admins[0].id : '<id>'}   # one invitation, printed once`]);
    return steps;
}

/**
 * The box the wizard ends with: what was chosen, what was written, which of the checks could be
 * made, and what is left for a person. It is one note because it is one thing to read, and it is
 * the last thing on the screen.
 *
 * The checks are reports and not gates, so a run that could not make one says which, in the same
 * place as the ones it could: `--skip-checks` and a box with no `node_modules` on it are both
 * ordinary, and neither is a failure.
 */
function reportSummary(report, state, resolved, { verified, checks, checked, wroteDirectory, done }) {
    const made = checked
        ? checkLines(checks, report.width)
        : ['The checks were not made: --skip-checks was passed.'];
    if (checked) {
        // "The front door" is this deployment's word for whichever door the mode opens, and a person
        // reading this box has just been asked which one they want: the sentence names its two halves
        // rather than leaving them to the runbook.
        made.push('', 'These are reports, not gates: none of them stops the install. The front door comes'
            + ' after this — the DNS record and Caddy\'s certificate in public mode, the Tailscale login'
            + ' in private mode — and `node src/admin.js doctor` asks all of them again once they are in'
            + ' place.');
    }
    report.note([
        columns(chosenPairs(state, resolved), report.width),
        '',
        columns(writtenPairs(state, resolved, wroteDirectory), report.width),
        '',
        made.join('\n'),
        '',
        columns(nextSteps(state, resolved, done), report.width),
    ].join('\n'), 'Crossbar setup');
    report.outro('Set up. `systemctl restart crossbar` when you are ready.');
}

// ── The last two questions, which run a command rather than write a file ────────
//
// The console's password and the first invitation are the two things a first install still needs
// a person for: one is a secret typed twice, and the other is a one-time code carried to a phone.
// Both used to be printed as next steps, which left the two states that look finished but are not
// — a console nobody can open, and no phone able to join. So they are asked here through the same
// prompter as every other question, and the command runs in this terminal so its own prompt and
// the token land where the person is looking. Both flows ask both questions, the short one
// included: a deployment that has just named its first administrator is where the invitation that
// lets a phone join is minted, and leaving its command in the summary left the app empty until
// somebody ran it by hand.
//
// Neither runs unattended. With no terminal there is nobody to answer the question and nobody to
// read the code, so the step is left in the summary rather than guessed at, and `--password` and
// `--invite` answer them from `--answers` or from a flag. An explicit false skips one without
// asking.

/**
 * Ask, and run, the two finishing steps. Returns which of them ran to completion, so the summary
 * says what is left rather than repeating what was done.
 *
 * The short run asks both, and a machine cannot answer either: a password is something no machine
 * can make, and an invitation is a code a person carries to a phone. A run with no terminal asks
 * neither and leaves the two commands in the summary, which is the one case where they are still
 * something for a person to do afterwards.
 */
async function finishByHand({ answers, terminal, report, state, resolved, spawn }) {
    /** `true`/`false` when an answer or a flag decided it, `null` when nobody has yet. */
    const answered = (key) => {
        const value = answers[key];
        return value === undefined || value === '' ? null : Boolean(value);
    };
    /** Yes or no, defaulted to yes — and `false` with no terminal, which never runs the command. */
    const askNow = async (message) => (terminal
        ? Boolean(await terminal.confirm({ message, initialValue: true }))
        : false);
    // The child reads `.env` itself, as the service does; it is handed no name this deployment
    // reads, so a value in the operator's shell cannot beat the file (`childEnv`).
    const runInTerminal = (args, title, note) => {
        report.note(note, title);
        const status = spawn(process.execPath, [path.join(__dirname, 'admin.js'), ...args], {
            cwd: state.dir, stdio: 'inherit', env: childEnv(),
        });
        // The command owns the terminal while it runs and leaves the cursor wherever its own
        // output ended. That is where the wizard's next line goes: it draws nothing over what is
        // on the screen, so the command's own prompt — and the `set` line it settles to — stays.
        return status === 0;
    };

    let password = false;
    if (answered('password') ?? (await askNow('Set the console password now? It guards the web console at /admin.'))) {
        if (terminal && spawn) {
            password = runInTerminal(['password'], 'The console password',
                'It is asked for and hashed by the command that owns the prompt, and never passes'
                + ' through this one.');
            if (!password) report.note('Run `node src/admin.js password` when you are ready.', 'The password was not set');
        } else {
            report.note('Setting it asks a person for something, and there is no terminal here.'
                + ' Run `node src/admin.js password`.', 'The console password was not set');
        }
    }

    let invite = false;
    // Asked in both flows: the invitation is what makes the directory this run just wrote usable
    // — a phone cannot join without one — and minting it here means the install ends having
    // finished, rather than having left a command in the summary for somebody to find later.
    const inviteWanted = answered('invite')
        ?? await askNow('Invite somebody now? It prints a one-time code for their phone');
    if (inviteWanted) {
        const admin = (resolved.directory?.users || state.directory?.users || [])
            .find((user) => user.admin && user.enabled !== false) || null;
        if (!admin) {
            report.note('There is no administrator in the directory to invite, so nobody was invited.'
                + ' Run `node src/admin.js enroll --user <id>` after naming one.', 'Nobody was invited');
        } else if (terminal && spawn) {
            invite = runInTerminal(['enroll', '--user', admin.id], 'The first invitation',
                `Give this to ${admin.id}'s phone: the code is printed once and stored nowhere.`);
            if (!invite) report.note(`Run \`node src/admin.js enroll --user ${admin.id}\` when you are ready.`, 'Nobody was invited');
        } else {
            report.note('An invitation is a code a person carries to a phone, and there is no terminal'
                + ` here. Run \`node src/admin.js enroll --user ${admin.id}\`.`, 'Nobody was invited');
        }
    }

    return { password, invite };
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
 * exit code. `tailscale` is the command this machine is joined through and the private address's
 * default is read from, `''` to skip both; a test hands it a fixture, as `checkTailscale` takes
 * one. `authkey` is a Tailscale auth key to join with when the installer carried one — it arrives
 * in `TS_AUTHKEY` from the installer, which is the variable `tailscale up` reads itself — and
 * `spawn` is what runs the login, in this terminal, like the two finishing steps below. `fetch` is
 * the seam the one request to the shared relay's `/v1/installations` goes through: Node's own in a
 * real run, and a stub in a test, so no test ever reaches the real relay.
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
    tailscale = 'tailscale',
    authkey = process.env.TS_AUTHKEY || '',
    locals = hostAddresses(),
    fetch: fetchImpl = globalThis.fetch,
} = {}) {
    const state = readState(dir);
    const { asker, terminal } = askLayer(ask);
    const report = makeReport(terminal, log);
    report.intro(`Crossbar setup${state.seeded
        ? ' — a first setup: .env is the copy of .env.example the installer seeded'
        : state.hasEnv ? ' — this deployment already has a .env' : ''}`);
    // The counterpart of `unreadEnvKeys`: a name this project reads that the shell already holds
    // beats `.env` in every command started from that shell, and the symptom names the setting
    // rather than the shell it came from. Said once, up front, because it is the operator's shell
    // that has to change and nothing later in the run would point there.
    const fromEnvironment = environmentKeys();
    if (fromEnvironment.length) {
        report.note(`Set in this shell's environment, so read in preference to .env by every`
            + ` command started from it — \`node src/admin.js ...\` included: ${fromEnvironment.join(', ')}.`
            + ' A stale or empty value here names the setting in the symptom, not the shell it came'
            + ' from. Unset them and run this again if that is not what you meant.',
        'The environment is overriding .env');
    }
    // The join happens inside, and only for a mode set that includes private: a public-only run
    // never spawns Tailscale.
    const resolved = await collectAnswers({
        answers, state, asker, terminal, report, generate, tailscale, authkey, spawn, locals,
        fetch: fetchImpl,
    });
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
        // Stopped with no line of its own: what it says it was doing is the record's line, and a
        // bare path under a `◇` reads as a fragment rather than as what happened.
        if (writing) writing.stop();
    } catch (error) {
        if (writing) writing.stop('nothing was written');
        throw error;
    }

    let checks = [];
    if (check) {
        const probing = terminal ? terminal.spinner() : null;
        if (probing) probing.start('Checking what this box looks like from outside');
        checks = await runChecks({ state, resolved, stunUrl, locals });
        if (probing) probing.stop();
    }

    // The two steps only a person can do, asked and run rather than left as next steps. With no
    // terminal the questions are not asked and the commands are not run; the summary says so.
    const done = await finishByHand({ answers, terminal, report, state, resolved, spawn });

    reportSummary(report, state, resolved, {
        verified,
        checks,
        checked: check,
        wroteDirectory: Boolean(resolved.directory),
        done,
    });

    return {
        envPath: state.envPath,
        directoryPath: state.directoryPath,
        inForce: resolved.inForce,
        modes: resolved.modes,
        secrets: { sessionFrom: resolved.secrets.sessionFrom, turnFrom: resolved.secrets.turnFrom },
        verify: verified,
        checks,
        done,
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
    tailnetName,
    parsePeople,
    parsePersonLine,
    shortIdFrom,
    ownBindAddress,
    DEFAULT_PUSH_RELAY_URL,
};
