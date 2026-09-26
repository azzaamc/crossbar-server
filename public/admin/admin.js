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
    // Nothing that is not an element or a string is appended: `append` turns a null child
    // into the word "null", which is how a conditional cell with nothing in it — the
    // actions on a spent invitation, say — used to read.
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
}

/** SVG has its own namespace: `createElement('svg')` makes an element nothing draws. */
function svg(tag, props = {}, children = []) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null) continue;
        node.setAttribute(key, String(value));
    }
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
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
            // First, because it is the one fact about a deployment nothing else here can
            // answer: the files on the box, the checkout somebody edited and the process
            // answering this page can be three different versions, and only the process
            // knows which one it is.
            card('Version', status.version),
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

/** A short id derived from a name, for the records: "Sara Ahmed" becomes "sara-ahmed". */
const slug = (text) => String(text || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

function peopleView(people, refresh, requireLogins) {
    // Above the names rather than beside the form. The point of the rule is who cannot be found,
    // which is a fact about the directory, so it is shown whenever the directory is — including
    // straight after an edit, since every edit reloads this list.
    const warnings = (people.warnings || []).length
        ? el('p', { class: 'muted' }, [
            el('strong', { text: 'Not found by a login: ' }),
            el('span', { text: people.warnings.join(' ') }),
        ])
        : null;
    const rows = people.map((person) => el('tr', { class: person.suspended ? 'inactive' : '' }, [
        el('td', { text: person.displayName }),
        el('td', { text: person.admin ? 'administrator' : '—' }),
        el('td', { text: person.suspended ? 'suspended' : person.arrived ? 'in the directory' : 'has not signed in' }),
        el('td', { class: 'numeric', text: person.devices }),
        el('td', { text: person.login || '—' }),
        el('td', { text: when(person.lastAuthenticated) }),
        el('td', {}, [el('div', { class: 'actions' }, [
            el('button', {
                type: 'button',
                text: person.suspended ? 'Restore' : 'Suspend',
                onClick: async () => {
                    // Suspending keeps everything about them except the ability to sign in.
                    await call(`/api/admin/people/${encodeURIComponent(person.id)}`, {
                        method: 'POST',
                        body: JSON.stringify({ enabled: person.suspended }),
                    });
                    await refresh();
                },
            }),
            el('button', {
                type: 'button',
                class: 'danger',
                text: 'Remove',
                onClick: async () => {
                    if (!confirm(`Take ${person.displayName} out of the directory?\n\n`
                        + 'Their devices stop working, and their calls stay in the records.')) return;
                    await call(`/api/admin/people/${encodeURIComponent(person.id)}/remove`, { method: 'POST' });
                    await refresh();
                },
            }),
        ])]),
    ]));

    const name = el('input', { placeholder: 'Name', autocomplete: 'off' });
    const id = el('input', {
        placeholder: 'short name',
        autocomplete: 'off',
        size: '12',
        title: 'How this person is named in the server’s own records, and in any link to them.',
    });
    const login = el('input', {
        placeholder: requireLogins ? 'Tailscale login' : 'Tailscale login (optional)',
        autocomplete: 'off',
        size: '22',
    });
    let idTouched = false;
    name.addEventListener('input', () => {
        if (!idTouched) id.value = slug(name.value);
    });
    id.addEventListener('input', () => { idTouched = true; });

    const notice = el('p', { class: 'muted' });
    const add = el('button', { type: 'button', class: 'primary', text: 'Add' });
    add.addEventListener('click', async () => {
        add.disabled = true;
        notice.className = 'muted';
        notice.textContent = 'Adding…';
        try {
            await call('/api/admin/people', {
                method: 'POST',
                body: JSON.stringify({
                    id: id.value,
                    displayName: name.value,
                    tailscaleLogin: login.value,
                }),
            });
            notice.textContent = '';
            await refresh();
        } catch (error) {
            notice.className = 'failed';
            notice.textContent = error.message;
            add.disabled = false;
        }
    });

    const addCard = el('div', { class: 'grant' }, [
        el('p', {
            text: 'The name is what everybody sees. The short name beside it is the id: how '
                + 'this person is named in the server’s own records. It fills in from the name '
                + 'as you type, and only needs changing if you would rather it read otherwise.',
        }),
        el('p', {
            text: requireLogins
                ? 'This server tells people apart by their tailnet login, so it is needed '
                    + 'here — the address they sign in with, like name@example.com.'
                : 'This server is reached with device keys, so a tailnet login is optional. '
                    + 'It is kept as a note of who somebody is elsewhere and used for nothing '
                    + 'else: leave it empty for anyone who has no tailnet.',
        }),
        el('div', { class: 'row' }, [name, id, login, add]),
        notice,
    ]);

    return section('People',
        ...(warnings ? [warnings] : []),
        table(['Name', 'Role', 'State', 'Devices', 'Login', 'Last authenticated', ''], rows,
            { numeric: ['Devices'] }),
        addCard);
}

/**
 * People the database has and the file does not name.
 *
 * A private deployment mints a person for any identity that reaches it, so somebody who
 * signs in arrives as a real person — devices, calls and history pointing at them — while
 * the directory file, which is what this page edits, has never heard of them. Measured
 * 2026-09-26: a probe login was `ts_72497f475e4f76d0b28f57c7 | Someone |
 * someone@example.com` in the database while the file still listed three people. Nothing
 * else on this page would show them, and hiding them would not be true: nothing here
 * decides whether their device key works.
 *
 * So the card says what happened and what the two honest answers are — write them into the
 * file, or take their device out of use — because "why is this person here at all" is not
 * a question the table can answer by itself.
 */
function unlistedView(unlisted, refresh) {
    if (!unlisted || !unlisted.length) return null;

    const rows = unlisted.map((person) => el('tr', { class: person.takenOutOfTheFile ? 'inactive' : '' }, [
        el('td', { text: person.displayName }),
        el('td', { text: person.login || '—' }),
        el('td', { class: 'numeric', text: person.devices }),
        el('td', { text: when(person.firstSeen) }),
        el('td', { text: when(person.lastAuthenticated) }),
        el('td', { text: person.takenOutOfTheFile ? 'taken out of the file' : 'arrived by signing in' }),
        el('td', {}, [el('div', { class: 'actions' }, [
            el('button', {
                type: 'button',
                class: 'primary',
                text: 'Write into the file',
                onClick: async () => {
                    // Under the id they already have. Any other id would leave this row
                    // behind — enabled, still holding their device keys — and make a second
                    // person of them, so the fix is to name the row that exists.
                    await call('/api/admin/people', {
                        method: 'POST',
                        body: JSON.stringify({
                            id: person.id,
                            displayName: person.displayName,
                            tailscaleLogin: person.login,
                        }),
                    });
                    await refresh();
                },
            }),
        ])]),
    ]));

    return section('Not in the directory file',
        el('p', {
            text: 'These people are in the server’s database and not in the file this page edits. '
                + 'A private deployment mints a person for any identity that reaches it, and that '
                + 'person is real whatever the file says: their devices work, their calls are '
                + 'recorded, and their history points at them.',
        }),
        el('p', {
            text: 'Writing somebody into the file puts them under the id they already have, so their '
                + 'devices and their history stay theirs, and it is the answer for somebody who '
                + 'belongs here. For somebody who does not, take their device out of use under '
                + 'Devices below: the file is not what makes a key work, so leaving a person out of '
                + 'it would not stop the phone.',
        }),
        table(['Name', 'Login', 'Devices', 'First seen', 'Last authenticated', 'Where they came from', ''], rows,
            { numeric: ['Devices'] }));
}

/**
 * Who can reach whom.
 *
 * Everybody reaches everybody, and there is nothing here to configure. A table of ticks was
 * here once and it was the shape of the mistake: reaching somebody is something two people do
 * together, so every tick had an opposite that had to stay in step with it, and an operator
 * keeping that true by hand is an operator who will one day not.
 *
 * So this says what is true, and offers the one act that makes it true again if something has
 * changed it. Somebody added to the directory already reaches everybody by the time they
 * appear, which is what makes this a description rather than a control.
 */
function contactsView(people, contacts, refresh) {
    if (people.length < 2) {
        return section('Who can reach whom',
            el('p', { class: 'muted', text: 'Reaching somebody takes two people. Add another one first.' }));
    }

    const reaches = new Set(contacts.map((item) => `${item.ownerId}\u2192${item.contactId}`));
    const missing = [];
    for (const owner of people) {
        for (const other of people) {
            if (owner.id !== other.id && !reaches.has(`${owner.id}\u2192${other.id}`)) {
                missing.push(`${owner.displayName} cannot reach ${other.displayName}`);
            }
        }
    }

    const note = el('p', {
        class: 'muted',
        text: 'Everybody here can reach everybody else, and somebody you add reaches them from '
            + 'the moment they arrive. Somebody who has not signed in yet is shown to nobody '
            + 'until they do \u2014 an invitation tells them how to arrive.',
    });

    if (!missing.length) {
        return section('Who can reach whom', note,
            el('p', { text: 'Everybody can reach everybody.' }));
    }

    // Only reachable at all through the API, which can still write a single pair. Said in
    // full: a count is not a fact anybody can act on.
    const shown = missing.slice(0, 6);
    const open = el('button', { type: 'button', class: 'primary', text: 'Let everybody reach everybody' });
    open.addEventListener('click', async () => {
        await call('/api/admin/contacts/everyone', { method: 'POST', body: '{}' });
        await refresh();
    });

    return section('Who can reach whom', note,
        el('p', {
            text: `${shown.join('; ')}${missing.length > shown.length
                ? `, and ${missing.length - shown.length} more`
                : ''}.`,
        }),
        el('div', { class: 'row' }, [open]));
}

function devicesView(devices, refresh) {
    const rows = devices.map((device) => {
        const row = el('tr', { class: device.status === 'active' ? '' : 'inactive' }, [
            el('td', { text: device.label || '(unlabelled)' }),
            el('td', { text: device.userName || device.userId }),
            el('td', { text: device.platform || '—' }),
            el('td', { text: device.status }),
            el('td', { text: device.hasKey ? 'yes' : 'no' }),
            // Whether a phone can be rung while it is asleep is a different fact from
            // whether it can be told anything, and it is the first thing to check when a
            // call does not arrive.
            el('td', {
                // `none` rather than nothing. A phone that can be rung and one that cannot
                // looked identical here — an empty cell — and a device enrolled during the
                // launch that gave it its push token files none, which is a state an operator
                // has to be able to see rather than deduce. Measured 2026-09-24.
                //
                // The `.filter(Boolean).join(' + ')` tail that used to hang off this
                // expression was dead code with a bug in it: `'none'.filter` is not a
                // function, so the first time a device had neither token — which is every
                // device on a first install — opening the console threw instead of drawing
                // this cell. Measured 2026-09-26.
                text: [device.hasVoipToken ? 'ring' : null, device.hasPushToken ? 'alerts' : null].filter(Boolean).join(', ') || 'none',
            }),
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
                }) : el('button', {
                    // Offered only once a device has been taken out of use. Revoking stops
                    // the key working and keeps the record; this is the record going too,
                    // and it cannot be undone, so the two are never the same click.
                    type: 'button',
                    class: 'danger',
                    text: 'Remove',
                    onClick: async () => {
                        if (!confirm(`Remove ${device.label || device.id} from the records?\n\n`
                            + 'Revoking it stopped it working. This takes the row away as well. '
                            + 'The calls it was in are kept, because those are recorded by person.')) return;
                        await call(`/api/admin/devices/${encodeURIComponent(device.id)}/remove`, { method: 'POST' });
                        await refresh();
                    },
                }),
            ])]),
        ]);
        return row;
    });
    if (!rows.length) return section('Devices', el('p', { class: 'muted', text: 'No device has been enrolled yet.' }));
    return section('Devices',
        el('p', {
            class: 'muted',
            text: 'A revoked device keeps its row: the key stops working, and the record of the '
                + 'phone that held it stays. Remove takes the row away as well, and appears only '
                + 'once a device has been revoked.',
        }),
        table(['Device', 'Person', 'Platform', 'State', 'Key', 'Push', 'Last seen', ''], rows));
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

/**
 * Inviting a device, which is the one thing an operator does most.
 *
 * Its own section, above the history and above the people, because it is the action this
 * page exists for — and because the code it hands out is shown exactly once, so it has to
 * be somewhere the eye already is.
 */
function inviteView(people, refresh) {
    const person = el('select', {}, people.map((user) => el('option', { value: user.id, text: user.displayName })));
    const ttl = el('input', { type: 'number', min: '60', step: '60', placeholder: 'seconds', size: '7' });
    const card = el('div', { class: 'grant' }, [
        el('p', {
            text: 'An invitation ties one device to one person, and it carries the address of '
                + 'this server, so the device does not have to be told it separately.',
        }),
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

    return section('Invite someone', card, ...grantsView());
}

function enrollmentsView(enrollments, refresh) {
    const rows = enrollments.map((item) => el('tr', { class: item.state === 'open' ? '' : 'inactive' }, [
        el('td', { text: item.id }),
        el('td', { text: item.intendedUserId || '—' }),
        el('td', { text: item.state }),
        el('td', { text: when(item.expiresAt) }),
        el('td', { text: item.createdBy || 'the command line' }),
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

    return section('Invitations',
        el('p', {
            class: 'muted',
            text: 'Every invitation this server has issued. A code is shown once, when it is '
                + 'created, and only its hash is kept — it cannot be read back from here.',
        }),
        table(['Id', 'For', 'State', 'Expires', 'Created by', ''], rows));
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
 * The way in for whoever runs this directory.
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
            text: 'Signing in here administers the directory: who is in it, which devices are '
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

/**
 * A bar per day. A fortnight of calls needs nothing more elaborate than that, and a chart
 * library would be a page of JavaScript to draw twenty-eight rectangles.
 */
function callChart(days) {
    const width = 640;
    const height = 120;
    const peak = Math.max(1, ...days.map((day) => day.calls));
    const slot = width / Math.max(1, days.length);
    const barWidth = Math.max(6, Math.min(26, slot - 6));
    const pieces = [];

    days.forEach((day, index) => {
        const barHeight = Math.round((day.calls / peak) * (height - 30));
        const x = index * slot + (slot - barWidth) / 2;
        pieces.push(svg('rect', {
            x,
            y: height - 20 - barHeight,
            width: barWidth,
            height: Math.max(barHeight, 1),
            rx: 3,
            // A day where everything was answered reads as the accent; a day with a missed
            // call in it does not, which is the one thing worth telling apart at a glance.
            fill: day.answered === day.calls ? 'var(--accent)' : 'var(--muted)',
        }));
        if (index % 2 === 0) {
            pieces.push(svg('text', {
                x: x + barWidth / 2,
                y: height - 6,
                'text-anchor': 'middle',
                'font-size': '9',
                fill: 'var(--muted)',
            }, [day.day.slice(5)]));
        }
    });

    return svg('svg', {
        viewBox: `0 0 ${width} ${height}`,
        width: '100%',
        height,
        role: 'img',
        'aria-label': `Calls per day over ${days.length} days`,
    }, pieces);
}

const gigabytes = (bytes) => `${(Number(bytes || 0) / 1024 / 1024 / 1024).toFixed(1)} GB`;

const duration = (seconds) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return days ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
};

const statCard = (label, value) => el('div', { class: 'card' }, [
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: String(value) }),
]);

function usageView(usage, people) {
    const known = new Map(people.map((person) => [person.id, person.displayName]));
    const total = usage.days.reduce((sum, day) => ({
        calls: sum.calls + day.calls,
        answered: sum.answered + day.answered,
        minutes: sum.minutes + (day.minutes || 0),
    }), { calls: 0, answered: 0, minutes: 0 });

    const pairs = usage.pairs.map((pair) => el('tr', {}, [
        el('td', { text: known.get(pair.from) || pair.from }),
        el('td', { text: known.get(pair.to) || pair.to }),
        el('td', { class: 'numeric', text: pair.calls }),
    ]));

    return section('Usage, the last fortnight',
        el('div', { class: 'cards' }, [
            statCard('Calls', total.calls),
            statCard('Answered', total.answered),
            statCard('Typical call', total.answered ? `${Math.round(total.minutes / total.answered)} min` : '—'),
            statCard('Invitations', `${usage.invitations.used} of ${usage.invitations.issued} used`),
            statCard('Devices', usage.platforms.reduce((sum, row) => sum + row.active, 0)),
        ]),
        el('div', { class: 'chart' }, [callChart(usage.days)]),
        usage.pairs.length
            ? table(['Who', 'Called', 'Times'], pairs, { numeric: ['Times'] })
            : el('p', { class: 'muted', text: 'Nobody has called anybody yet.' }));
}

function hostView(host) {
    return section('This machine',
        el('div', { class: 'cards' }, [
            statCard('Load', `${host.load.one.toFixed(2)} · ${host.load.five.toFixed(2)} · ${host.load.fifteen.toFixed(2)}`),
            statCard('Cores', host.load.cpus),
            statCard('Memory used', `${gigabytes(host.memory.total - host.memory.free)} of ${gigabytes(host.memory.total)}`),
            statCard('Disk free', host.disk ? gigabytes(host.disk.free) : 'not readable'),
            statCard('Database', gigabytes(host.database)),
            statCard('Machine up', duration(host.uptime.host)),
            statCard('Server up', duration(host.uptime.process)),
        ]));
}

/**
 * Asks for a change, waits for the server to come back, and reloads.
 *
 * Every change here restarts the service, because the configuration is read once at start
 * and that is the only moment it is consistent. The page says so, then waits on
 * `/api/health`, which is the one route answered before anything else can be.
 */
async function applyChange(route, body, question) {
    if (question && !confirm(question)) return;
    show('Applying…');
    try {
        const result = await call(route, { method: 'POST', body: JSON.stringify(body) });
        if (!result.restarting) {
            await refresh();
            return;
        }
    } catch (error) {
        show(error.message, true);
        return;
    }

    show('Restarting. This page reloads when the server is back.');
    for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
            const response = await fetch('/api/health', { cache: 'no-store' });
            if (response.ok) {
                location.reload();
                return;
            }
        } catch {
            // Still down, which is what a restart looks like from here.
        }
    }
    show('It has not come back. It will need looking at on the box.', true);
}

function settingsView(settings) {
    const fields = new Map();
    const rows = settings.knobs.map((knob) => {
        const input = knob.type === 'boolean'
            ? el('select', {}, [
                el('option', { value: 'true', text: 'on', selected: knob.value === true }),
                el('option', { value: 'false', text: 'off', selected: knob.value === false }),
            ])
            : el('input', { value: String(knob.value ?? ''), size: '14', autocomplete: 'off' });
        fields.set(knob.key, { knob, input });
        return el('tr', {}, [
            el('td', {}, [
                el('div', { text: knob.label }),
                knob.help ? el('div', { class: 'muted', text: knob.help }) : null,
            ]),
            el('td', { class: 'mono', text: knob.key }),
            el('td', {}, [input]),
            el('td', { class: 'muted', text: knob.unit || (knob.type === 'boolean' ? 'on / off' : '') }),
        ]);
    });

    const notice = el('p', { class: 'muted' });
    const save = el('button', { type: 'button', class: 'primary', text: 'Save and restart' });
    save.addEventListener('click', async () => {
        const changes = {};
        for (const [key, { knob, input }] of fields) {
            const value = knob.type === 'boolean' ? input.value === 'true' : input.value;
            if (String(value) !== String(knob.value === true ? 'true' : knob.value === false ? 'false' : knob.value)) {
                changes[key] = value;
            }
        }
        if (!Object.keys(changes).length) {
            notice.textContent = 'Nothing has changed.';
            return;
        }
        save.disabled = true;
        await applyChange('/api/admin/settings', { changes }, null);
        save.disabled = false;
    });

    const modeCards = settings.modes.map((entry) => el('div', { class: `card${entry.inForce ? ' active' : ''}` }, [
        el('div', { class: 'label', text: entry.inForce ? `${entry.mode} — in force` : entry.mode }),
        el('div', { class: 'value', text: entry.hostname || 'not configured' }),
        entry.origin ? el('div', { class: 'muted mono', text: entry.origin }) : null,
        entry.inForce ? null : el('button', {
            type: 'button',
            text: `Switch to ${entry.mode}`,
            onClick: () => applyChange('/api/admin/mode', { mode: entry.mode },
                `Switch this server to ${entry.mode}?\n\nIt restarts, and everyone reconnects. `
                + (entry.hostname ? `It will be reached at ${entry.origin}.` : 'That mode has no address set, so this will be refused.')),
        }),
    ]));

    return section('Settings',
        el('p', {
            class: 'muted',
            text: 'Changing anything here writes it to the server’s configuration and restarts it. '
                + 'Everything is checked first, and undone if the server would not start — the '
                + 'settings that could lock you out are not on this list.',
        }),
        table(['Setting', 'Name', 'Value', ''], rows),
        el('div', { class: 'row' }, [save, notice]),
        el('h3', { text: 'Where this server is reached' }),
        el('div', { class: 'cards' }, modeCards));
}

// ── Wiring ──────────────────────────────────────────────────────────────────────

const main = document.getElementById('main');

function show(text, failed = false) {
    main.replaceChildren(el('p', { class: failed ? 'failed' : 'muted', text }));
}

async function refresh() {
    try {
        const [status, people, devices, enrollments, usage, host, settings] = await Promise.all([
            call('/api/admin/status'),
            call('/api/admin/people'),
            call('/api/admin/devices'),
            call('/api/admin/enrollments'),
            call('/api/admin/usage'),
            call('/api/admin/host'),
            call('/api/admin/settings'),
        ]);
        main.replaceChildren(
            ...[
                serverView(status),
                inviteView(people.people, refresh),
                peopleView(people.people, refresh, people.requireLogins),
                // Null when the file and the database agree, which is the ordinary case: a
                // section that said "none" every day would be a section nobody reads.
                unlistedView(people.unlisted || [], refresh),
                contactsView(people.people, people.contacts || [], refresh),
                devicesView(devices.devices, refresh),
                enrollmentsView(enrollments.enrollments, refresh),
                usageView(usage, people.people),
                hostView(host),
                settingsView(settings),
                browserFoot(),
            ].filter(Boolean),
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
