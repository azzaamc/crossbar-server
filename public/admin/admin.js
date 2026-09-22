'use strict';

// The operator console: a view over `/api/admin/*` and nothing more.
//
// It holds no state the server does not hold, decides nothing the server does not
// decide, and never sees a secret — those routes already leave key material out. Every
// request goes to the same origin, so the content-security-policy the server sends
// needs no exception, and no value that came from the server is ever inserted as HTML.

async function call(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    const token = CrossbarDevice.token();
    if (token) headers['x-crossbar-session'] = token;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));

    // A session that has expired is not a refusal of what was asked: the key is still here,
    // so ask for another one and do the thing once more. 401 only — a 403 says this person
    // may not, and asking again would not change that.
    if (response.status === 401 && !options.afterRenewal && CrossbarDevice.supported) {
        try {
            if (await CrossbarDevice.session()) return call(path, { ...options, afterRenewal: true });
        } catch {
            // Fall through to the server's own refusal, which says more than this could.
        }
    }

    if (!response.ok) {
        const failure = new Error(data?.error?.message || `The server refused that (HTTP ${response.status}).`);
        failure.status = response.status;
        failure.code = data?.error?.code;
        throw failure;
    }
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

/** SVG has its own namespace: `createElement('svg')` makes an element nothing draws. */
function svg(tag, props = {}, children = []) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null) continue;
        node.setAttribute(key, String(value));
    }
    node.append(...children);
    return node;
}

/**
 * The invitation payload as a QR code.
 *
 * Scanning is the point of enrolment — a code copied by hand is a code mistyped — and the
 * encoder is vendored beside this file rather than fetched, because the policy the server
 * sends allows no other script. Drawn as modules in an SVG, with four modules of quiet
 * zone and its own white field, so it reads the same off a dark page as a light one and
 * survives a screenshot.
 */
function qrSvg(text, size = 180) {
    const code = qrcode(0, 'M');
    code.addData(text, 'Byte');
    code.make();
    const count = code.getModuleCount();
    const modules = [];
    for (let row = 0; row < count; row += 1) {
        for (let column = 0; column < count; column += 1) {
            if (code.isDark(row, column)) modules.push(`M${column} ${row}h1v1h-1z`);
        }
    }
    const quiet = 4;
    const side = count + quiet * 2;
    return svg('svg', {
        viewBox: `${-quiet} ${-quiet} ${side} ${side}`,
        width: size,
        height: size,
        role: 'img',
        'aria-label': 'Invitation QR code',
        'shape-rendering': 'crispEdges',
    }, [
        svg('rect', { x: -quiet, y: -quiet, width: side, height: side, fill: '#ffffff' }),
        svg('path', { d: modules.join(''), fill: '#000000' }),
    ]);
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
        el('div', { class: 'qr' }, [qrSvg(JSON.stringify(grant.payload))]),
        el('p', { text: 'Give this to the device. It can scan the code, or take the token:' }),
        el('code', { text: grant.token }),
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

/**
 * What to show a browser the server does not recognise.
 *
 * On a public deployment nothing vouches for a request, so a browser needs a key of its own
 * before any of this will answer — the same thing the phone app holds. The code comes from
 * Crossbar on a device that is already enrolled; the key that spends it is made here and
 * kept unreadable, even to this page.
 */
function showEnrolment(notice) {
    const code = el('input', { type: 'password', placeholder: 'Enrolment code', autocomplete: 'off' });
    const message = el('p', { class: notice ? 'failed' : 'muted', text: notice || '' });
    const button = el('button', { type: 'button', class: 'primary', text: 'Enrol this browser' });
    button.addEventListener('click', async () => {
        button.disabled = true;
        message.className = 'muted';
        message.textContent = 'Enrolling…';
        try {
            const device = await CrossbarDevice.enroll(code.value);
            message.textContent = `Enrolled as ${device.name || device.id}.`;
            await refresh();
        } catch (error) {
            message.className = 'failed';
            message.textContent = error.message;
            button.disabled = false;
        }
    });

    main.replaceChildren(
        el('h2', { text: 'This browser' }),
        el('p', {
            text: 'Nothing vouches for a browser on this deployment, so it needs a key of its '
                + 'own — the same thing the phone app holds. Get an enrolment code from Crossbar '
                + 'on a device that is already enrolled, and enter it here.',
        }),
        el('div', { class: 'grant' }, [el('div', { class: 'row' }, [code, button]), message]),
    );
}

/**
 * The way in for whoever runs this household.
 *
 * The console is an operator surface, not a client, so it takes a password — kept on the
 * server only as a hash, and answered with a session cookie this page cannot read. The
 * device-key path is still underneath: a browser that has enrolled one is admitted without
 * being asked anything, so this appears only when there is neither.
 */
function showLogin(message, withoutPassword) {
    if (withoutPassword) {
        // No password has been set on this server, so the only way in is a device key.
        showEnrolment(message);
        return;
    }

    const password = el('input', {
        type: 'password',
        placeholder: 'Console password',
        autocomplete: 'current-password',
    });
    const notice = el('p', { class: message ? 'failed' : 'muted', text: message || '' });
    const button = el('button', { type: 'button', class: 'primary', text: 'Sign in' });

    const signIn = async () => {
        button.disabled = true;
        notice.className = 'muted';
        notice.textContent = 'Checking…';
        try {
            const response = await fetch('/api/admin/session', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ password: password.value }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                notice.className = 'failed';
                notice.textContent = data?.error?.message || `The server refused that (HTTP ${response.status}).`;
                button.disabled = false;
                return;
            }
            await refresh();
        } catch (error) {
            notice.className = 'failed';
            notice.textContent = error.message;
            button.disabled = false;
        }
    };

    button.addEventListener('click', signIn);
    password.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') signIn();
    });

    main.replaceChildren(
        el('h2', { text: 'This console' }),
        el('p', {
            text: 'Signing in here administers the household: who is in it, which devices are '
                + 'enrolled, and how the server itself is configured. The password is checked '
                + 'against a hash on the server and never travels anywhere else.',
        }),
        el('div', { class: 'grant' }, [el('div', { class: 'row' }, [password, button]), notice]),
    );
    password.focus();
}

/** What this browser is, and the way to stop being it. */
function browserFoot() {
    const signOut = el('button', { type: 'button', text: 'Sign out' });
    signOut.addEventListener('click', async () => {
        await fetch('/api/admin/signout', { method: 'POST' });
        await refresh();
    });

    const forget = el('button', { type: 'button', class: 'danger', text: 'Forget this browser' });
    forget.addEventListener('click', async () => {
        if (!confirm('Forget the key this browser holds? Enrolling it again needs a new code.')) return;
        await CrossbarDevice.forget();
        show('This browser has been forgotten. Reload to enrol it again.');
    });

    return el('p', { class: 'foot' }, [
        el('span', {
            class: 'muted',
            text: CrossbarDevice.supported
                ? 'This browser signs in with a key of its own, kept unreadable on this device.'
                : 'This browser cannot keep a key: it needs a secure connection to this server.',
        }),
        signOut,
        forget,
    ]);
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
            browserFoot(),
        );
    } catch (error) {
        // Refused for who this browser is, rather than for what it asked: the answer is the
        // operator's password — unless the server has none set, in which case it is a device
        // key, which is what the enrolment panel is for.
        if (error.status === 401 || error.status === 403 || error.code === 'OPERATOR_DISABLED') {
            showLogin(error.message || '', error.code === 'OPERATOR_DISABLED');
            return;
        }
        show(error.message, true);
    }
}

document.getElementById('refresh').addEventListener('click', () => {
    show('Reading the server…');
    refresh();
});

refresh();
