'use strict';

// The operator console: a view over `/api/admin/*` and nothing more.
//
// It holds no state the server does not hold, decides nothing the server does not
// decide, and never sees a secret — those routes already leave key material out. Every
// request goes to the same origin, so the content-security-policy the server sends
// needs no exception, and no value that came from the server is ever inserted as HTML.

const TOKEN_KEY = 'crossbar-admin-token';

/** The session token, if this browser was handed one. Held for the tab, not the disk. */
function heldToken() {
    const given = new URLSearchParams(location.search).get('token');
    if (given) {
        sessionStorage.setItem(TOKEN_KEY, given.trim());
        // Out of the address bar and out of any bookmark, without a reload.
        history.replaceState(null, '', location.pathname);
    }
    return sessionStorage.getItem(TOKEN_KEY) || '';
}

async function call(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    const token = heldToken();
    if (token) headers['x-crossbar-session'] = token;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `The server refused that (HTTP ${response.status}).`);
    return data;
}

/** Elements are built rather than parsed, so a display name is never markup. */
function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'text') node.textContent = String(value);
        else if (key === 'onClick') node.addEventListener('click', value);
        else if (key === 'class') node.className = value;
        else node.setAttribute(key, value === true ? '' : String(value));
    }
    node.append(...children);
    return node;
}

const when = (value) => (value ? value.replace('T', ' ').replace(/\..*$/, ' UTC') : 'never');

function section(title, ...children) {
    return el('section', {}, [el('h2', { text: title }), ...children]);
}

function table(headings, rows, { numeric = [] } = {}) {
    return el('table', {}, [
        el('thead', {}, [el('tr', {}, headings.map((heading) => el('th', {
            text: heading,
            class: numeric.includes(heading) ? 'numeric' : undefined,
        })))]),
        el('tbody', {}, rows),
    ]);
}

// ── Views ───────────────────────────────────────────────────────────────────────

function serverView(status) {
    const card = (label, value) => el('div', { class: 'card' }, [
        el('div', { class: 'label', text: label }),
        el('div', { class: 'value', text: value }),
    ]);
    return section('Server',
        el('div', { class: 'cards' }, [
            card('Mode', status.mode),
            card('Hostname', status.hostname || 'not set'),
            card('Origin', status.origin),
            card('Device authentication', !status.deviceAuthEnabled ? 'not configured'
                : (status.requireDeviceAuth ? 'required' : 'available')),
            card('Relay', status.turn ? `${status.turn.host}:${status.turn.port}` : 'not configured'),
            card('People', status.users),
            card('Devices', status.devices),
            card('Open invitations', status.openEnrollments),
        ]));
}

function peopleView(users) {
    const rows = users.map((user) => el('tr', {}, [
        el('td', { text: user.displayName }),
        el('td', { text: user.admin ? 'administrator' : '—' }),
        el('td', { class: 'numeric', text: user.activeDevices ?? 0 }),
        el('td', { text: user.login }),
        el('td', { text: when(user.lastAuthenticated) }),
    ]));
    if (!rows.length) return section('People', el('p', { class: 'muted', text: 'Nobody is in the household file.' }));
    return section('People', table(['Name', 'Role', 'Devices', 'Login', 'Last authenticated'], rows, { numeric: ['Devices'] }));
}

function devicesView(devices, refresh) {
    const rows = devices.map((device) => {
        const row = el('tr', { class: device.status === 'active' ? '' : 'inactive' }, [
            el('td', { text: device.label || '(unlabelled)' }),
            el('td', { text: device.userName || device.userId }),
            el('td', { text: device.platform || '—' }),
            el('td', { text: device.status }),
            el('td', { text: device.hasKey ? 'yes' : 'no' }),
            el('td', { text: device.hasPushToken ? 'yes' : 'no' }),
            el('td', { text: when(device.lastSeenAt) }),
            el('td', {}, [el('div', { class: 'actions' }, [
                el('button', {
                    type: 'button',
                    text: 'Rename',
                    onClick: async () => {
                        const label = prompt('Name this device', device.label || '');
                        if (!label) return;
                        await call(`/api/admin/devices/${encodeURIComponent(device.id)}/rename`, {
                            method: 'POST',
                            body: JSON.stringify({ label }),
                        });
                        await refresh();
                    },
                }),
                device.status === 'active' ? el('button', {
                    type: 'button',
                    class: 'danger',
                    text: 'Revoke',
                    onClick: async () => {
                        if (!confirm(`Take ${device.label || device.id} out of use? `
                            + 'The person keeps their other devices.')) return;
                        await call(`/api/admin/devices/${encodeURIComponent(device.id)}/revoke`, { method: 'POST' });
                        await refresh();
                    },
                }) : null,
            ])]),
        ]);
        return row;
    });
    if (!rows.length) return section('Devices', el('p', { class: 'muted', text: 'No device has been enrolled yet.' }));
    return section('Devices', table(
        ['Device', 'Person', 'Platform', 'State', 'Key', 'Push', 'Last seen', ''],
        rows,
    ));
}

/**
 * Codes handed out in this tab.
 *
 * The server keeps only a hash, so it cannot repeat one: if a refresh cleared this, the
 * code would be gone the moment it was created. They live here and nowhere else — not
 * in storage, not on disk — and last as long as the page does.
 */
const grants = [];

function grantsView() {
    return grants.map((grant) => el('div', { class: 'grant' }, [
        el('p', { text: `${grant.for} — expires ${when(grant.expiresAt)}` }),
        el('code', { text: grant.token }),
        el('p', { text: 'Give this to the device. It accepts the token, or the whole payload:' }),
        el('code', { text: JSON.stringify(grant.payload) }),
    ]));
}

function enrollmentsView(enrollments, people, refresh) {
    const rows = enrollments.map((item) => el('tr', { class: item.state === 'open' ? '' : 'inactive' }, [
        el('td', { text: item.id }),
        el('td', { text: item.intendedUserId || '—' }),
        el('td', { text: item.state }),
        el('td', { text: when(item.expiresAt) }),
        el('td', { text: item.createdBy || 'cli' }),
        el('td', {}, [item.state === 'open' ? el('button', {
            type: 'button',
            class: 'danger',
            text: 'Withdraw',
            onClick: async () => {
                await call(`/api/admin/enrollments/${encodeURIComponent(item.id)}/revoke`, { method: 'POST' });
                await refresh();
            },
        }) : null]),
    ]));

    // An invitation always names the person it is for: an unbound code would let
    // whoever held it choose whose identity to take.
    const person = el('select', {}, people.map((user) => el('option', { value: user.id, text: user.displayName })));
    const ttl = el('input', { type: 'number', min: '60', step: '60', placeholder: 'seconds', size: '7' });
    const card = el('div', { class: 'grant' }, [
        el('p', { text: 'Invite a device. The code is shown once and cannot be read back.' }),
        el('div', { class: 'row' }, [
            person,
            ttl,
            el('button', {
                type: 'button',
                class: 'primary',
                text: 'Create invitation',
                onClick: async (event) => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    try {
                        const body = { userId: person.value };
                        if (ttl.value) body.ttlSeconds = Number(ttl.value);
                        const made = await call('/api/admin/enrollments', { method: 'POST', body: JSON.stringify(body) });
                        grants.unshift({
                            for: person.options[person.selectedIndex].text,
                            expiresAt: made.enrollment.expiresAt,
                            token: made.payload.enrollment_token,
                            payload: made.payload,
                        });
                        await refresh();
                    } finally {
                        button.disabled = false;
                    }
                },
            }),
        ]),
    ]);

    return section('Invitations',
        table(['Id', 'For', 'State', 'Expires', 'Created by', ''], rows),
        card,
        ...grantsView());
}

// ── Wiring ──────────────────────────────────────────────────────────────────────

const main = document.getElementById('main');

function show(text, failed = false) {
    main.replaceChildren(el('p', { class: failed ? 'failed' : 'muted', text }));
}

async function refresh() {
    try {
        const [status, people, devices, enrollments] = await Promise.all([
            call('/api/admin/status'),
            call('/api/admin/users'),
            call('/api/admin/devices'),
            call('/api/admin/enrollments'),
        ]);
        main.replaceChildren(
            serverView(status),
            peopleView(people.users),
            devicesView(devices.devices, refresh),
            enrollmentsView(enrollments.enrollments, people.users, refresh),
        );
    } catch (error) {
        show(error.message, true);
    }
}

document.getElementById('refresh').addEventListener('click', () => {
    show('Reading the server…');
    refresh();
});

refresh();
