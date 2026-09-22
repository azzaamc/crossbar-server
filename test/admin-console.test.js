'use strict';

// The operator console is served by the Crossbar server itself: the same origin as the
// API it calls, and the same identity rules. What matters here is that it is reachable,
// that its own files are the only files it can reach, and that the page gives nothing
// away on its own — every fact on it comes from a route that checks who is asking.

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, api } = require('./helpers');

async function get(base, route) {
    const response = await fetch(`${base}${route}`);
    return {
        status: response.status,
        type: response.headers.get('content-type') || '',
        body: await response.text(),
    };
}

test('the console is served from the server, and names its own parts', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    const page = await get(base, '/admin');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.body, /\/admin\/admin\.js/);
    // Nothing inline: the policy the server sends is `script-src 'self'`.
    assert.doesNotMatch(page.body, /<script>(?!\s*<\/script>)/);
});

test('its own files are served, and nothing above them', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    assert.equal((await get(base, '/admin')).status, 200);
    assert.equal((await get(base, '/admin/')).status, 200);
    assert.equal((await get(base, '/admin/admin.js')).status, 200);
    assert.equal((await get(base, '/admin/admin.css')).status, 200);
    // The page loads these by name, so they have to be there under those names.
    assert.equal((await get(base, '/admin/device.js')).status, 200);
    assert.equal((await get(base, '/admin/qrcode.js')).status, 200);
    assert.equal((await get(base, '/admin/nothing-here')).status, 404);
    // A path that climbs out of the console's directory is refused, never resolved.
    assert.equal((await get(base, '/admin/..%2fsrc%2fserver.js')).status, 400);
    assert.equal((await get(base, '/admin/%2e%2e%2fsrc%2fserver.js')).status, 400);
});

test('the page is public and every fact on it is not', async (t) => {
    const { server, base } = await startTestServer();
    t.after(() => server.close());
    // Whoever asks gets the page; it carries no household data of its own.
    const page = await get(base, '/admin');
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.body, /abdullah/i);

    // The data behind it does not.
    assert.equal((await api(base, null, '/api/admin/status')).status, 401);
    assert.equal((await api(base, 'dad@dev', '/api/admin/status')).status, 403);
    assert.equal((await api(base, 'abdullah@dev', '/api/admin/status')).status, 200);
});
