'use strict';

// The setup wizard's browser front end: a temporary listener that serves the same questions the
// command line asks and hands the answers to the same engine.
//
// It exists because the person who owns the box is not always the person at the shell. Filling in
// a hostname, an origin, a bind address and a directory of people through a sequence of prompts
// means getting every answer right in one pass, with a typo in answer four costing the whole run;
// a form shows all of them at once, next to what the file already holds. That convenience is the
// only reason this process exists, and it is why nothing here is allowed to be more than a front
// end: every answer goes through `runSetup`, which is the same function `node src/admin.js setup`
// calls, so the two cannot behave differently — including the parts that matter most, that
// nothing is written until every chosen mode is complete and that a failed write puts back what
// it replaced.
//
// Four properties decide its shape.
//
// **Temporary by construction.** It is a process, not a daemon: it exits when setup finishes
// (success or refusal), on Ctrl-C, and when the code it printed expires. It holds no state worth
// keeping, and it cannot be reached again afterwards — `systemctl` never learns about it and it
// writes no unit.
//
// **Loopback unless told otherwise, and never unauthenticated.** The default bind is `127.0.0.1`;
// a wider bind needs `--bind`, and even then no request is answered without the one-time code.
// The code is what makes a wider bind defensible at all: a listener that writes this deployment's
// `.env` is the most valuable target on the box, so it is guarded by a secret that is printed to
// the operator's terminal, compared in constant time, usable once, and dead within minutes.
//
// **One self-contained document.** No build step, no external asset, no CDN — the console's own
// style, inlined, because the box this runs on may have no route to the internet and because a
// page that fetches anything is a page that leaks the code in a `Referer`.
//
// **Nothing secret in the document.** The code travels in the request URL and is exchanged, on
// the one successful request that carries it, for an `HttpOnly` session cookie; the form that
// comes back names no secret, and the code appears in exactly one place in the whole process —
// the line printed to the operator's terminal, which is what printing it means. It is never
// echoed into a response body, never written to any other output, and never repeated after that
// first line. What the page reports back is what the engine said — its summary and its checks,
// including the ones it could not make.

const crypto = require('node:crypto');
const http = require('node:http');

const { modeConfigured } = require('./config');
const { SetupRefusal, hostAddresses, readState, runSetup } = require('./setup');

/** The one bind this page takes without being asked, and the only one that needs no justification. */
const DEFAULT_BIND = '127.0.0.1';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
/** Every spelling of "every address", which has to be displayed as one address to be reachable. */
const WILDCARD = new Set(['0.0.0.0', '::', '[::]', '*']);

/**
 * How long the code lives, and why fifteen minutes.
 *
 * The code is minted when the command starts, and the person it was printed for is sitting in
 * front of the terminal it was printed to. So this window is not how long setup takes — it is how
 * long the credential stays worth stealing. A quarter of an hour is long enough to read the line,
 * open it on another machine and answer eighteen fields; it is short enough that a URL left in a
 * scrollback, a terminal multiplexer's buffer or a screenshot is dead by the time anything finds
 * it. The listener's deadline is the same clock, deliberately: once the code has expired nothing
 * can authenticate to the page, and a listener nobody can reach is only a port held open.
 */
const CODE_TTL_MS = 15 * 60 * 1000;

/**
 * 16 bytes of hex, not the 32 the `.env` secrets get. This one has to be short enough to be read
 * off one screen and typed on another, which is the case `--bind` exists for; 128 bits is still
 * unguessable against a credential that dies in minutes, and the comparison is constant-time so
 * its length is the only thing a probe can learn.
 */
const CODE_BYTES = 16;
/** The cookie is the code's replacement, not the code: fresh, opaque, and never printed. */
const SESSION_BYTES = 32;
/** A form of answers, not a payload: the largest thing this accepts is the people file as JSON. */
const MAX_BODY = 256 * 1024;

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

/** Equal without telling the caller where the first difference is, and without leaking a length. */
function safeEqual(given, held) {
    const left = Buffer.from(String(given ?? ''), 'utf8');
    const right = Buffer.from(String(held ?? ''), 'utf8');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

/**
 * What this deployment is already set up as, or null.
 *
 * The question is the one the mode units ask before they open a front door (`modeConfigured`, on
 * the mode the file says it is in), because that is what "configured" means here: the file names
 * the mode and that mode's block holds everything it needs to start. A file with an empty block —
 * which is exactly what a fresh install copies from `.env.example` — is not configured, and this
 * page is the fastest way to fill it in.
 */
function configuredMode(dir) {
    const state = readState(dir);
    if (!state.hasEnv || !state.written) return null;
    if (!modeConfigured(state.written, state.envPath).configured) return null;
    return { mode: state.written, envPath: state.envPath };
}

/** The session cookie's value, or null: the name is this page's alone, and nothing else sets it. */
function cookieToken(request) {
    for (const part of String(request.headers.cookie || '').split(';')) {
        const trimmed = part.trim();
        if (trimmed.startsWith('crossbar-setup=')) return trimmed.slice('crossbar-setup='.length);
    }
    return null;
}

/** The body as text, refused rather than buffered without limit. */
function readBody(request) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new SetupRefusal('That is more than this page accepts in one submission.'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}

/**
 * Where the person should be told to open the page, given what it is bound to.
 *
 * A wildcard bind answers on every interface, and the first one `os.networkInterfaces()` reports
 * is routinely a link-local IPv6 address (`fe80::…`) — reachable only from the same link, and
 * needing a scope id before a browser will open it at all. Printing that would hand the operator
 * a URL that cannot work, so an IPv4 address is preferred and link-local ones are passed over.
 */
function displayHost(address, locals) {
    if (LOOPBACK.has(address)) return '127.0.0.1';
    if (!WILDCARD.has(address)) return address;
    const usable = locals.filter((entry) => !/^(fe80|169\.254\.)/i.test(entry));
    return usable.find((entry) => !entry.includes(':')) || usable[0] || '127.0.0.1';
}

/**
 * The form, in one document.
 *
 * Nothing here is fetched and nothing here is built: the style is the console's own variables and
 * rules, inlined, and the script is plain enough to read in the page source. The form has no
 * `action` — the script posts to `/setup`, which keeps the code out of the document entirely —
 * and every field that carries an answer is marked `data-answer`, so what the page submits is
 * exactly the answers object the CLI builds from its flags.
 */
const DOCUMENT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Crossbar — setup</title>
<style>
:root {
    color-scheme: light dark;
    --ink: #16181d; --muted: #6b7280; --line: #d9dce1;
    --paper: #ffffff; --wash: #f6f7f9; --accent: #1f6feb; --danger: #b3261e;
}
@media (prefers-color-scheme: dark) {
    :root {
        --ink: #e8eaed; --muted: #9aa0a6; --line: #33373d;
        --paper: #17191c; --wash: #1e2124; --accent: #7aa7ff; --danger: #ff8a80;
    }
}
* { box-sizing: border-box; }
body {
    margin: 0; padding: 0 1.25rem 4rem; background: var(--paper); color: var(--ink);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
header {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    max-width: 62rem; margin: 0 auto; padding: 1.5rem 0 1rem; border-bottom: 1px solid var(--line);
}
h1 { margin: 0; font-size: 1.25rem; letter-spacing: -0.01em; }
.sub { margin: 0.15rem 0 0; color: var(--muted); font-size: 0.85rem; }
main { max-width: 62rem; margin: 0 auto; }
section { margin-top: 2rem; }
.muted { color: var(--muted); }
.failed { color: var(--danger); }
.notice { margin-top: 1rem; padding: 0.7rem 0.85rem; border-radius: 8px; background: var(--wash); border: 1px solid var(--line); }
fieldset { margin: 1.5rem 0 0; padding: 0.85rem 1rem 1.1rem; border: 1px solid var(--line); border-radius: 8px; }
legend { padding: 0 0.4rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
label { display: block; margin-top: 0.75rem; font-size: 0.9rem; }
label span { display: block; color: var(--muted); font-size: 0.82rem; }
input, select, textarea {
    font: inherit; width: 100%; margin-top: 0.25rem; padding: 0.3rem 0.5rem;
    border: 1px solid var(--line); border-radius: 6px; background: var(--paper); color: var(--ink);
}
textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; }
.inline { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.75rem; }
.inline input { width: auto; margin: 0; }
button {
    font: inherit; padding: 0.3rem 0.7rem; border: 1px solid var(--line); border-radius: 6px;
    background: var(--wash); color: var(--ink); cursor: pointer; margin-top: 1.25rem;
}
button:hover { border-color: var(--accent); color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover { color: #fff; opacity: 0.9; }
pre.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; white-space: pre-wrap; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
</style>
</head>
<body>
<header>
    <div>
        <h1>Crossbar</h1>
        <p class="sub">First-run setup — the same questions the command line asks</p>
    </div>
</header>

<main>
    <p class="notice">
        Nothing is written until every answer a chosen mode needs is present, and a write that
        fails puts back the file it replaced. Leave a field blank to keep what the deployment
        already holds. This page closes itself when setup finishes.
    </p>

    <form id="setup">
        <fieldset>
            <legend>Modes</legend>
            <label>How will people reach this deployment?
                <span>over your Tailscale network only, over the open internet, or both</span>
                <select data-answer="mode" required>
                    <option value="" disabled selected>choose one</option>
                    <option value="private">Tailscale only (private)</option>
                    <option value="public">Open internet (public)</option>
                    <option value="both">both</option>
                </select>
            </label>
            <label>Which one should this deployment use now?
                <span>"in force" — the mode the server and its front door start in; blank keeps the one the file already says</span>
                <select data-answer="inForce">
                    <option value="" selected>keep what the file says</option>
                    <option value="private">private</option>
                    <option value="public">public</option>
                </select>
            </label>
        </fieldset>

        <fieldset>
            <legend>Private (tailnet)</legend>
            <label>The address your people's phones dial over the tailnet
                <span>Tailscale gives this machine one; <code>tailscale status</code> prints it — e.g. crossbar.tailnet-name.ts.net</span>
                <input data-answer="privateHostname" autocomplete="off" spellcheck="false">
            </label>
            <label>The web address an invitation opens
                <span>the same tailnet address with https:// in front; blank derives it — e.g. https://crossbar.tailnet-name.ts.net</span>
                <input data-answer="privateOrigin" autocomplete="off" spellcheck="false">
            </label>
        </fieldset>

        <fieldset>
            <legend>Public (open internet)</legend>
            <label>The public address people reach this deployment at
                <span>a name you own whose DNS points at this server — e.g. calls.example.com</span>
                <input data-answer="publicHostname" autocomplete="off" spellcheck="false">
            </label>
            <label>The web address an invitation opens
                <span>the same public name with https:// in front; blank derives it — e.g. https://calls.example.com</span>
                <input data-answer="publicOrigin" autocomplete="off" spellcheck="false">
            </label>
            <label>The one local address Caddy listens on
                <span>this server's own address — never 0.0.0.0, which tailscaled already holds — e.g. 203.0.113.10</span>
                <input data-answer="publicBindAddress" autocomplete="off" spellcheck="false">
            </label>
        </fieldset>

        <fieldset>
            <legend>The directory</legend>
            <label>One person per line: "id, display name, login, admin"
                <span>the id is a short username and the display name is what the app shows; the login and the word "admin" may be left blank</span>
                <textarea data-answer="people" rows="5" autocomplete="off" spellcheck="false"></textarea>
            </label>
            <label>Or a directory file to use as the people
                <span>give this or the list above, not both; blank keeps the file already there</span>
                <input data-answer="directory" autocomplete="off" spellcheck="false">
            </label>
        </fieldset>

        <fieldset>
            <legend>Relay and push</legend>
            <label>A TURN server, for calls that cannot connect directly
                <span>its hostname, e.g. relay.example.com; blank for no relay</span>
                <input data-answer="turnHost" autocomplete="off" spellcheck="false">
            </label>
            <label>Its shared secret
                <span>blank generates one</span>
                <input data-answer="turnSecret" autocomplete="off" spellcheck="false">
            </label>
            <label>An Apple push key id, for ringing an iPhone whose screen is off
                <span>from your Apple developer account, e.g. ABC123DE45; blank skips APNs</span>
                <input data-answer="apnsKeyId" autocomplete="off" spellcheck="false">
            </label>
            <label>APNs team id
                <span>e.g. TEAM123456</span>
                <input data-answer="apnsTeamId" autocomplete="off" spellcheck="false">
            </label>
            <label>The .p8 key file on this server
                <span>e.g. /etc/crossbar/apns.p8</span>
                <input data-answer="apnsKeyPath" autocomplete="off" spellcheck="false">
            </label>
            <label>The app's bundle id
                <span>e.g. com.example.crossbar</span>
                <input data-answer="apnsTopic" autocomplete="off" spellcheck="false">
            </label>
            <label>A VAPID public key, for waking a browser tab that is closed
                <span>blank skips Web Push</span>
                <input data-answer="vapidPublicKey" autocomplete="off" spellcheck="false">
            </label>
            <label>The VAPID private key
                <span>a long base64 string</span>
                <input data-answer="vapidPrivateKey" autocomplete="off" spellcheck="false">
            </label>
            <label>The VAPID contact subject
                <span>a mailto: or a URL, e.g. mailto:you@example.com</span>
                <input data-answer="vapidSubject" autocomplete="off" spellcheck="false">
            </label>
        </fieldset>

        <fieldset>
            <legend>Secrets and finishes</legend>
            <label>The session secret
                <span>blank keeps the one in the file, or generates one</span>
                <input data-answer="sessionSecret" autocomplete="off" spellcheck="false">
            </label>
            <div class="inline">
                <input type="checkbox" id="newSecrets" data-answer="newSecrets">
                <label for="newSecrets">Generate new secrets even though the file holds some
                    <span>this signs every device out</span>
                </label>
            </div>
            <div class="inline">
                <input type="checkbox" id="password" data-answer="password">
                <label for="password">Set the console password at the terminal afterwards
                    <span>it is asked for where this command is running, never here</span>
                </label>
            </div>
            <div class="inline">
                <input type="checkbox" id="invite" data-answer="invite">
                <label for="invite">Invite somebody at the terminal afterwards
                    <span>a one-time code is printed there for their phone, never here</span>
                </label>
            </div>
        </fieldset>

        <button class="primary" type="submit">Write it and check it</button>
    </form>

    <section id="report" hidden></section>
</main>

<script>
(function () {
    var form = document.getElementById('setup');
    var report = document.getElementById('report');

    function tableOf(checks) {
        var table = document.createElement('table');
        for (var index = 0; index < checks.length; index += 1) {
            var row = table.insertRow();
            row.insertCell().textContent = String(checks[index].verdict || '').toUpperCase();
            row.insertCell().textContent = checks[index].name || '';
            row.insertCell().textContent = checks[index].detail || '';
        }
        return table;
    }

    function show(body) {
        report.hidden = false;
        while (report.firstChild) report.removeChild(report.firstChild);
        var heading = document.createElement('h2');
        heading.textContent = body.status === 'set-up' ? 'Done' : 'Refused';
        report.appendChild(heading);
        if (body.error) {
            var failure = document.createElement('pre');
            failure.className = 'mono failed';
            failure.textContent = body.error;
            report.appendChild(failure);
        }
        var lines = document.createElement('pre');
        lines.className = 'mono';
        lines.textContent = (body.lines || []).join('\\n');
        report.appendChild(lines);
        if (body.result && body.result.checks && body.result.checks.length) {
            report.appendChild(tableOf(body.result.checks));
        }
        if (body.status === 'set-up') {
            var note = document.createElement('pre');
            note.className = 'mono';
            note.textContent = 'This page is closed now. Continue in the terminal this command is running in.';
            report.appendChild(note);
        }
    }

    form.addEventListener('submit', function (event) {
        event.preventDefault();
        var answers = {};
        var fields = form.querySelectorAll('[data-answer]');
        for (var index = 0; index < fields.length; index += 1) {
            var field = fields[index];
            var key = field.getAttribute('data-answer');
            if (field.type === 'checkbox') {
                if (field.checked) answers[key] = true;
                continue;
            }
            var value = field.value.trim();
            if (value) answers[key] = value;
        }
        if (typeof answers.people === 'string') {
            answers.people = answers.people.split('\\n')
                .map(function (line) { return line.trim(); })
                .filter(function (line) { return line.length > 0; });
            if (!answers.people.length) delete answers.people;
        }
        report.hidden = false;
        while (report.firstChild) report.removeChild(report.firstChild);
        var waiting = document.createElement('p');
        waiting.className = 'muted';
        waiting.textContent = 'Writing and checking\\u2026';
        report.appendChild(waiting);
        fetch('/setup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(answers),
        }).then(function (response) {
            return response.json();
        }).then(show).catch(function (error) {
            while (report.firstChild) report.removeChild(report.firstChild);
            var failed = document.createElement('pre');
            failed.className = 'mono failed';
            failed.textContent = String(error);
            report.appendChild(failed);
        });
    });
}());
</script>
</body>
</html>
`;

/** A refusal in the same voice as the engine's, with nothing about the request in it. */
const REFUSED = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
    + '<title>Crossbar — setup</title></head><body>'
    + '<h1>Not this one</h1>'
    + '<p>This page is opened with the one-time code the command printed. Every request without a '
    + 'code it has not already used is refused, and nothing here repeats what was sent.</p>'
    + '</body></html>\n';

/**
 * Serve the wizard on a temporary listener, and return a handle on it.
 *
 * `done` resolves once the listener is closed, with `{ status, result?, error?, lines? }`:
 * `set-up` when the engine wrote the deployment, `refused` when it would not, `expired` when the
 * code outlived its window, `interrupted` on Ctrl-C. The listener always closes itself — there is
 * no path through here that leaves it running.
 */
async function serveSetupPage({
    dir = process.cwd(),
    answers = {},
    bind = null,
    port = 0,
    force = false,
    check = true,
    log = console.log,
    ttlMs = CODE_TTL_MS,
    locals = null,
} = {}) {
    const already = configuredMode(dir);
    if (already && !force) {
        throw new SetupRefusal(`This deployment is already set up for ${already.mode}: ${already.envPath}`
            + ' names the mode and its block is complete, so this page would rewrite a working'
            + ' deployment. --force says to go ahead anyway.');
    }

    const address = bind || DEFAULT_BIND;
    const code = hex(CODE_BYTES);
    let session = null;
    let spent = false;
    const expiresAt = Date.now() + ttlMs;

    let settled = null;
    let closed = false;
    let deadline = null;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });

    /** The code is spent on the first request that carries it, and on no other. */
    const redeem = (given) => {
        // Compared before the state is looked at, so an expired or already-used code costs the
        // same as a fresh one: what a probe can learn from the answer is the answer itself.
        const matches = safeEqual(given, code);
        if (!matches || spent || Date.now() > expiresAt) return false;
        spent = true;
        session = hex(SESSION_BYTES);
        return true;
    };
    const authorised = (request) => session !== null && safeEqual(cookieToken(request), session);

    const send = (response, status, type, body, extra = {}) => {
        response.writeHead(status, {
            'content-type': type,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            // The code travels in the URL, so a page that could be referred from would hand it
            // to whatever it was referred to. There is nothing to refer from — but saying so is
            // cheaper than depending on it.
            'referrer-policy': 'no-referrer',
            ...extra,
        });
        response.end(body);
    };

    const runEngine = async (posted) => {
        const lines = [];
        const record = (line) => { lines.push(String(line)); log(String(line)); };
        try {
            const result = await runSetup({
                dir,
                // What the command line was given first, and what the person typed over it: the
                // more specific answer wins, exactly as a flag wins over an answers file.
                answers: { ...answers, ...posted },
                // No terminal: the page is the place asking, and an engine that also prompted
                // would block on a stdin nobody is watching.
                ask: null,
                log: record,
                check,
            });
            return { status: 'set-up', result, lines };
        } catch (error) {
            if (!(error instanceof SetupRefusal)) throw error;
            record(error.message);
            return { status: 'refused', error: error.message, lines };
        }
    };

    const handle = async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (request.method === 'GET' && url.pathname === '/') {
            const given = url.searchParams.get('code');
            if (given !== null && redeem(given)) {
                // `Secure` is deliberately absent: the page is served over loopback HTTP, and a
                // cookie the browser then refuses to send would leave the form unable to submit.
                // `SameSite=Strict` is what keeps another page from reaching this one at all.
                return send(response, 200, 'text/html; charset=utf-8', DOCUMENT, {
                    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline';"
                        + " script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
                    'set-cookie': `crossbar-setup=${session}; HttpOnly; SameSite=Strict; Path=/;`
                        + ` Max-Age=${Math.floor(ttlMs / 1000)}`,
                });
            }
            if (authorised(request)) return send(response, 200, 'text/html; charset=utf-8', DOCUMENT);
            return send(response, 403, 'text/html; charset=utf-8', REFUSED);
        }

        if (request.method === 'POST' && url.pathname === '/setup') {
            if (!authorised(request)) return send(response, 403, 'text/html; charset=utf-8', REFUSED);
            let posted;
            try {
                posted = JSON.parse(await readBody(request));
                if (!posted || typeof posted !== 'object' || Array.isArray(posted)) throw new Error('not an object');
            } catch (error) {
                return send(response, 400, 'application/json; charset=utf-8',
                    JSON.stringify({ status: 'bad-request', error: `The answers have to be one JSON object: ${error.message}` }));
            }
            const outcome = await runEngine(posted);
            settled = outcome;
            // Registered before the response is written, because `close` fires as soon as the
            // body is flushed and the ordering the other way round is a race, not a sequence.
            response.on('close', () => close(outcome.status));
            send(response, 200, 'application/json; charset=utf-8', JSON.stringify(outcome));
            return undefined;
        }

        return send(response, 404, 'text/html; charset=utf-8',
            '<!doctype html>\n<p>This page serves one form and one submission.</p>\n');
    };

    const server = http.createServer((request, response) => {
        handle(request, response).catch((error) => {
            // The one place an unexpected failure is written down, and it is the operator's own
            // terminal: a bug here must not be reported as an answer problem, and the listener
            // stays up so the same form can be tried again.
            console.error(String(error && error.stack) || String(error));
            if (!response.writableEnded) {
                send(response, 500, 'application/json; charset=utf-8',
                    JSON.stringify({ status: 'error', error: 'The page itself failed; the terminal has the detail.' }));
            }
        });
    });

    const close = (reason = 'closed') => {
        if (closed) return;
        closed = true;
        clearTimeout(deadline);
        process.removeListener('SIGINT', onInterrupt);
        server.closeAllConnections?.();
        server.close(() => finish({ ...(settled || {}), status: reason }));
    };

    const onInterrupt = () => {
        log('');
        log('  Interrupted: the page is closed, and nothing was written after the last answer.');
        close('interrupted');
    };

    await new Promise((resolve, reject) => {
        server.once('error', (error) => reject(new SetupRefusal(
            error && error.code === 'EADDRINUSE'
                ? `Port ${port} is already in use, so the setup page could not open there.`
                : `The setup page could not listen: ${String(error && error.message)}`)));
        server.once('listening', resolve);
        server.listen(port, address);
    });

    deadline = setTimeout(() => {
        log('');
        log('  The one-time code has expired, so the page is closed and this command is done.'
            + ' Nothing was written. Run it again for a new code.');
        close('expired');
    }, ttlMs);
    deadline.unref?.();
    process.once('SIGINT', onInterrupt);

    const actual = server.address();
    const host = displayHost(address, locals || hostAddresses());
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${actual.port}/?code=${code}`;

    log('');
    log('  Crossbar setup — open this page, and answer the questions there:');
    log('');
    log(`    ${url}`);
    log('');
    log(`  The code in it is single-use and expires in ${Math.round(ttlMs / 60000)} minutes, after which`
        + ' this page closes itself.');
    if (!LOOPBACK.has(address)) {
        // Said plainly because it is true: this option exists for the operator who cannot open a
        // browser on the box, and it trades the loopback guarantee for reachability. The one-time
        // code travels the same unencrypted wire as the answers, so it belongs on a network the
        // operator already trusts — a tailnet, or an SSH tunnel — and nowhere else.
        log(`  Bound to ${address}, not loopback: this connection is not encrypted, and the code and the`
            + ' answers cross it as they are. Use it on a network you already trust. It refuses every');
        log('  request without the code, and there is no way past that.');
    }
    log('');
    log('  Nothing is written until the answers are complete; the page exits when setup finishes.');

    return {
        url,
        code,
        port: actual.port,
        close,
        done,
    };
}

module.exports = { serveSetupPage };
