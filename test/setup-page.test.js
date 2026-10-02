'use strict';

// The wizard's browser front end, end to end: a real listener on a loopback port, real requests
// against it, and the same files on disk the command line writes.
//
// The page adds exactly one thing to the engine — a way to reach it from a browser — so the tests
// are about the guard around the door and about the door leading to the same room. The guard is
// the code: refused without it, refused with a wrong one, spent by the first request that uses it,
// and dead when it expires. The room is the engine: the same answers posted here have to produce
// the same bytes as the same answers passed to `node src/admin.js setup`, or the front end has
// quietly become a second wizard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ADMIN = path.join(__dirname, '..', 'src', 'admin.js');
const { modeBlock, modeConfigured } = require('../src/config');
const { runSetup } = require('../src/setup');
const { serveSetupPage } = require('../src/setup-page');

/** The `.env` an install seeds: both blocks, the switch's section, and nothing filled in. */
const TEMPLATE = `HOST=127.0.0.1
PORT=3003

NETWORK_MODE_PRIVATE_HOSTNAME=
NETWORK_MODE_PRIVATE_ORIGIN=

NETWORK_MODE_PUBLIC_HOSTNAME=
NETWORK_MODE_PUBLIC_ORIGIN=
NETWORK_MODE_PUBLIC_BIND_ADDRESS=

# >>> the configuration in force, written by \`node src/admin.js mode\` >>>
CROSSBAR_NETWORK_MODE=private
CROSSBAR_PUBLIC_HOSTNAME=
PUBLIC_ORIGIN=
CROSSBAR_BIND_ADDRESS=
TRUST_TAILSCALE_HEADERS=
CROSSBAR_REQUIRE_DEVICE_AUTH=
# <<< end of the configuration in force <<<

DATA_DIR=./data
DIRECTORY_CONFIG_PATH=./data/directory.json
ICE_STUN_URL=stun:stun.l.google.com:19302
CROSSBAR_SESSION_SECRET=
CROSSBAR_TURN_HOST=
CROSSBAR_TURN_SHARED_SECRET=
`;

const PEOPLE = [
    { id: 'abdullah', name: 'Abdullah', login: 'abdullah@dev', admin: true },
    { id: 'dad', name: 'Dad', login: 'dad@dev' },
];

const BOTH = {
    mode: 'both',
    privateHostname: 'house.tailnet.ts.net',
    privateOrigin: 'https://house.tailnet.ts.net',
    publicHostname: 'crossbar.example.com',
    publicOrigin: 'https://crossbar.example.com',
    publicBindAddress: '203.0.113.7',
};

function deployment(t, seed = TEMPLATE) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossbar-page-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, '.env'), seed);
    return dir;
}

const envOf = (dir) => fs.readFileSync(path.join(dir, '.env'), 'utf8');
const directoryOf = (dir) => fs.readFileSync(path.join(dir, 'data', 'directory.json'), 'utf8');

/** The command line the page has to agree with, run the way a person runs it. */
function cliSetup(dir, answers) {
    const file = path.join(dir, 'answers.json');
    fs.writeFileSync(file, `${JSON.stringify(answers, null, 2)}\n`);
    return spawnSync(process.execPath, [ADMIN, 'setup', '--answers', file, '--skip-checks'], {
        cwd: dir,
        env: { PATH: process.env.PATH },
        encoding: 'utf8',
    });
}

/** A page on an ephemeral loopback port, closed when the test ends whether or not it closed itself. */
async function openPage(t, dir, options = {}) {
    const page = await serveSetupPage({ dir, check: false, log: () => {}, ttlMs: 60_000, ...options });
    t.after(() => page.close());
    return page;
}

const baseOf = (page) => `http://127.0.0.1:${page.port}`;

/** The URL as printed, which is the only place the code is offered. */
const cookieOf = (response) => {
    const header = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()[0]
        : response.headers.get('set-cookie');
    return header ? header.split(';')[0] : null;
};

const submit = (page, cookie, answers) => fetch(`${baseOf(page)}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(answers),
});

test('a request without the code is refused', async (t) => {
    const dir = deployment(t);
    const page = await openPage(t, dir);

    // Nothing is served to a request that does not carry the code — not even a hint that there is
    // a form behind it — and nothing about the request is echoed back in the refusal.
    const bare = await fetch(`${baseOf(page)}/`);
    assert.equal(bare.status, 403);
    assert.doesNotMatch(await bare.text(), /<form/);

    const post = await submit(page, null, BOTH);
    assert.equal(post.status, 403);
    assert.equal(envOf(dir), TEMPLATE, 'and nothing was written');

    const other = await fetch(`${baseOf(page)}/anything`);
    assert.equal(other.status, 404);
});

test('a wrong code is refused', async (t) => {
    const dir = deployment(t);
    const page = await openPage(t, dir);

    for (const wrong of ['', 'nonsense', page.code.slice(0, -1), `${page.code}0`]) {
        const response = await fetch(`${baseOf(page)}/?code=${encodeURIComponent(wrong)}`);
        assert.equal(response.status, 403, `"${wrong}" must be refused`);
        assert.doesNotMatch(await response.text(), /<form/);
    }
    assert.equal(envOf(dir), TEMPLATE);
});

test('the right code reaches the form, and the form carries no secret', async (t) => {
    const dir = deployment(t);
    const page = await openPage(t, dir);

    const response = await fetch(page.url, { redirect: 'manual' });
    assert.equal(response.status, 200);
    const cookie = cookieOf(response);
    assert.match(cookie, /^crossbar-setup=[0-9a-f]{64}$/);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);

    const document = await response.text();
    assert.match(document, /<form id="setup"/);
    assert.match(document, /data-answer="publicBindAddress"/);
    // The two things the page had to gain with the command line: the same basic/advanced choice,
    // and the same person question — a display name first, with the id derived from it.
    assert.match(document, /data-answer="approach"/);
    assert.match(document, /data-answer="pushRelayUrl"/);
    assert.match(document, /crossbar-push-dev\.ibnfaisalc\.workers\.dev/, 'the shared relay is not named');
    assert.match(document, /One person per line: "display name, login, admin"/);
    // And the questions that were removed are not still in the form.
    assert.doesNotMatch(document, /data-answer="apns|data-answer="vapid/);
    // The code is the credential that got here, and it is not in the document that came back:
    // the form posts to `/setup` with the cookie, so nothing a browser renders names it.
    assert.equal(document.includes(page.code), false, 'the code must not appear in the page');
    assert.equal(document.includes(cookie.split('=')[1]), false, 'nor the session that replaced it');
    assert.match(response.headers.get('content-security-policy'),
        /default-src 'none'.*connect-src 'self'/, 'the document may reach nothing but itself');

    // A reload keeps working through the cookie alone, which is what makes the code single-use.
    const again = await fetch(`${baseOf(page)}/`, { headers: { cookie } });
    assert.equal(again.status, 200);
    assert.match(await again.text(), /<form id="setup"/);
});

test('the code is spent by the first request that uses it', async (t) => {
    const dir = deployment(t);
    const page = await openPage(t, dir);

    assert.equal((await fetch(page.url)).status, 200);
    const second = await fetch(page.url);
    assert.equal(second.status, 403, 'the code is one use, not one session');
});

test('posted answers produce the same files as the command line with the same answers', async (t) => {
    const viaCli = deployment(t);
    const viaPage = deployment(t);
    // Fixed secrets, because both runs have to be the same answers rather than two rolls of the
    // same dice: what is being compared is the mapping from answers to files, not the generator.
    const answers = {
        ...BOTH,
        people: PEOPLE,
        turnHost: 'relay.example.com',
        sessionSecret: 'ab'.repeat(32),
        turnSecret: 'cd'.repeat(32),
    };

    const cli = cliSetup(viaCli, answers);
    assert.equal(cli.status, 0, cli.stderr);

    const page = await openPage(t, viaPage);
    const form = await fetch(page.url);
    const response = await submit(page, cookieOf(form), answers);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'set-up', body.error);

    assert.equal(envOf(viaPage), envOf(viaCli), 'the .env is the same bytes the CLI writes');
    assert.equal(directoryOf(viaPage), directoryOf(viaCli), 'and so is the directory file');
    assert.deepEqual(modeBlock(envOf(viaPage), 'public'), modeBlock(envOf(viaCli), 'public'));
    assert.equal(modeConfigured('public', path.join(viaPage, '.env')).configured, true);

    // What the page reports is the engine's own report, checks and all.
    assert.ok(body.result.checks.every((check) => typeof check.verdict === 'string'));
    assert.ok(body.lines.some((line) => /Crossbar setup/.test(line)));
});

test('the basic answers work through the page as they do on the command line', async (t) => {
    // The page has the same fork the terminal has, and the same person question: a display name
    // with no id, from which the id is derived. A basic run through either front end derives the
    // origin, the bind address from this host and the relay on this server.
    const viaCli = deployment(t);
    const viaPage = deployment(t);
    const answers = {
        approach: 'basic',
        mode: 'public',
        publicHostname: 'crossbar.example.com',
        publicBindAddress: '203.0.113.7',
        people: [{ name: 'Abdullah Al-Faisal', login: 'abdullah@dev', admin: true }],
        sessionSecret: 'ab'.repeat(32),
        // Fixed for the same reason the other equivalence test fixes them: the two runs are being
        // compared on the mapping from answers to files, not on two rolls of the generator.
        turnSecret: 'cd'.repeat(32),
    };

    const cli = cliSetup(viaCli, answers);
    assert.equal(cli.status, 0, cli.stderr);

    const page = await openPage(t, viaPage);
    const form = await fetch(page.url);
    const body = await (await submit(page, cookieOf(form), answers)).json();
    assert.equal(body.status, 'set-up', body.error);

    assert.equal(envOf(viaPage), envOf(viaCli), 'the .env is the same bytes the CLI writes');
    assert.equal(directoryOf(viaPage), directoryOf(viaCli), 'and so is the directory file');
    // The id came from the display name, on both front ends.
    assert.deepEqual(JSON.parse(directoryOf(viaPage)).users.map((user) => user.id), ['abdullah-al-faisal']);
    // What the short run derived: the origin from the name, the relay as this server, and the
    // shared push relay.
    assert.match(envOf(viaPage), /^NETWORK_MODE_PUBLIC_ORIGIN=https:\/\/crossbar\.example\.com$/m);
    assert.match(envOf(viaPage), /^CROSSBAR_TURN_HOST=crossbar\.example\.com$/m);
    assert.match(envOf(viaPage), /^CROSSBAR_PUSH_RELAY_URL=https:\/\/crossbar-push-dev\.ibnfaisalc\.workers\.dev$/m);
});

test('the listener closes when setup finishes', async (t) => {
    const dir = deployment(t);
    const page = await openPage(t, dir);
    const form = await fetch(page.url);
    const answers = { ...BOTH, people: PEOPLE, turnHost: 'relay.example.com', turnSecret: 'cd'.repeat(32) };

    assert.equal((await submit(page, cookieOf(form), answers)).status, 200);
    const outcome = await page.done;
    assert.equal(outcome.status, 'set-up');
    assert.equal(outcome.result.inForce, 'private', 'the mode the file already said is kept');

    // Temporary by construction: the port is gone as soon as the answers are written.
    await assert.rejects(fetch(`${baseOf(page)}/`));
});

test('a refusal from the engine closes the page and leaves the deployment untouched', async (t) => {
    const dir = deployment(t);
    const page = await openPage(t, dir);
    const form = await fetch(page.url);

    // Public with no name to be reached at: the engine refuses before writing, exactly as it does
    // under the CLI, and the page reports that refusal rather than inventing an answer.
    const response = await submit(page, cookieOf(form), {
        mode: 'public',
        publicBindAddress: '203.0.113.7',
        people: PEOPLE,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'refused');
    assert.match(body.error, /--public-hostname/);

    assert.equal((await page.done).status, 'refused');
    assert.equal(envOf(dir), TEMPLATE, 'the .env is byte-for-byte what it was');
    assert.equal(fs.existsSync(path.join(dir, 'data')), false, 'and nothing else was written either');
});

test('the code expires, and the listener closes with it', async (t) => {
    const dir = deployment(t);
    const page = await openPage(t, dir, { ttlMs: 50 });

    // The deadline is the code's own clock: once nothing can authenticate, a listener is a port
    // held open for nothing.
    assert.equal((await page.done).status, 'expired');
    await assert.rejects(fetch(page.url));
    assert.equal(envOf(dir), TEMPLATE);
});

test('a deployment that is already set up is refused unless it is forced', async (t) => {
    const dir = deployment(t);
    await runSetup({
        dir,
        answers: { ...BOTH, people: PEOPLE, turnHost: 'relay.example.com', turnSecret: 'cd'.repeat(32) },
        ask: null,
        log: () => {},
        check: false,
    });
    const written = envOf(dir);

    await assert.rejects(
        serveSetupPage({ dir, check: false, log: () => {} }),
        /already set up for private/,
    );
    assert.equal(envOf(dir), written);

    // `--force` is the way past it, and it is the operator saying the rewrite is what they want.
    const forced = await serveSetupPage({ dir, force: true, check: false, log: () => {} });
    t.after(() => forced.close());
    assert.equal((await fetch(forced.url)).status, 200);
});

test('a wider bind is refused a request without the code as well', async (t) => {
    // The code is what makes a non-loopback bind defensible, so the one thing that must hold there
    // is the same as on loopback: nothing is answered without it.
    const dir = deployment(t);
    const page = await openPage(t, dir, { bind: '0.0.0.0' });
    assert.equal((await fetch(`${baseOf(page)}/`)).status, 403);
    assert.equal((await fetch(page.url)).status, 200);
});
