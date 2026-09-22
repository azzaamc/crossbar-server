'use strict';

// This browser as a device.
//
// A public deployment has no network to vouch for anyone: a device proves itself with a key
// only it holds. The native app keeps that key in the Secure Enclave; a browser keeps it
// here, generated unextractable, which is the nearest a page has to that promise —
// `extractable: false` means the private key never exists as bytes this script could read,
// copy or send anywhere.
//
// The signing contract is the app's, to the byte: `crossbar-device-auth-v1`, then the device
// id, the challenge id and the nonce, newline-terminated on the first three and not on the
// last. WebCrypto produces the raw r‖s that P-256 arithmetic gives; the server verifies the
// DER that CryptoKit writes, so `derSignature` is the whole of the difference between them.

const CrossbarDevice = (() => {
    const DB_NAME = 'crossbar-device';
    const DB_STORE = 'keys';
    const RECORD = 'identity';
    const TOKEN = 'crossbar-session-token';

    /** A key can only exist in a secure context: WebCrypto and IndexedDB are both withheld otherwise. */
    const supported = typeof crypto !== 'undefined' && Boolean(crypto.subtle)
        && typeof indexedDB !== 'undefined';

    /** The session in hand: this page's memory first, then the tab's own store. */
    let session = null;

    function heldToken() {
        return session || sessionStorage.getItem(TOKEN) || '';
    }

    function remember(value) {
        session = value || null;
        if (value) sessionStorage.setItem(TOKEN, value);
        else sessionStorage.removeItem(TOKEN);
    }

    function withStore(mode, run) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const asked = run(request.result.transaction(DB_STORE, mode).objectStore(DB_STORE));
                asked.onsuccess = () => resolve(asked.result);
                asked.onerror = () => reject(asked.error);
            };
        });
    }

    const held = () => withStore('readonly', (store) => store.get(RECORD)).catch(() => undefined);
    const keep = (record) => withStore('readwrite', (store) => store.put(record, RECORD));

    /**
     * The two halves of a P-256 signature, as the DER the server verifies.
     *
     * WebCrypto hands back r‖s with no framing, because that is what the curve arithmetic
     * produces; every other ECDSA implementation in this project — CryptoKit on the phone,
     * Node on the server — speaks DER.
     */
    function derSignature(raw) {
        const bytes = new Uint8Array(raw);
        if (bytes.length !== 64) throw new Error('A P-256 signature is 64 bytes of r and s.');
        const integer = (start) => {
            let from = start;
            while (from < start + 31 && bytes[from] === 0) from += 1;
            const body = Array.from(bytes.slice(from, start + 32));
            // A DER integer is signed, so one whose top bit is set needs a zero byte first.
            return body[0] & 0x80 ? [0, ...body] : body;
        };
        const r = integer(0);
        const s = integer(32);
        const body = [0x02, r.length, ...r, 0x02, s.length, ...s];
        return Uint8Array.from([0x30, body.length, ...body]).buffer;
    }

    function base64(buffer) {
        let binary = '';
        for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
        return btoa(binary);
    }

    async function post(route, body) {
        const response = await fetch(route, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => ({}));
        return { ok: response.ok, status: response.status, data };
    }

    function complain(result, fallback) {
        return new Error(result.data?.error?.message || `${fallback} (HTTP ${result.status}).`);
    }

    /** What a code carries: the service's JSON payload, or a bare token. */
    function parseCode(text) {
        const trimmed = String(text || '').trim();
        if (trimmed.startsWith('{')) {
            try {
                const shape = JSON.parse(trimmed);
                const token = shape.enrollment_token || shape.token;
                if (typeof token === 'string' && token.trim()) {
                    return {
                        token: token.trim(),
                        server: typeof shape.server === 'string' ? shape.server : null,
                    };
                }
            } catch {
                // Not a payload after all. Read it as a bare token, exactly as the app does:
                // a field is not a parser, and the server is the authority on a token.
            }
        }
        return trimmed ? { token: trimmed, server: null } : null;
    }

    async function generate() {
        // Unextractable, because nothing needs the bytes and everything is safer without
        // them: signing is done by the browser's own key material.
        const pair = await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['sign']);
        const record = {
            privateKey: pair.privateKey,
            publicKey: base64(await crypto.subtle.exportKey('spki', pair.publicKey)),
        };
        await keep(record);
        return record;
    }

    return {
        supported,

        token: heldToken,
        remember,

        /** The key this browser holds, if it holds one. */
        async identity() {
            if (!supported) return null;
            const record = await held();
            return record ? { ...record } : null;
        },

        /** Spends an enrolment code and keeps the key that comes out of it. */
        async enroll(code) {
            const parsed = parseCode(code);
            if (!parsed) throw new Error('That does not look like an enrolment code.');

            // A payload names the service it belongs to. This page can only speak to the one
            // that served it, so a code for somewhere else is refused rather than half-spent.
            if (parsed.server) {
                let named;
                try {
                    named = new URL(parsed.server, location.href);
                } catch {
                    throw new Error('That code names a service address this browser cannot read.');
                }
                if (named.origin !== location.origin) {
                    throw new Error(`That code is for ${named.origin}, and this page is ${location.origin}.`);
                }
            }

            const record = await generate();
            const result = await post('/api/auth/enroll', {
                token: parsed.token,
                publicKey: record.publicKey,
                algorithm: 'ES256',
                deviceName: 'Browser',
                platform: 'browser',
            });
            if (!result.ok) throw complain(result, 'The server refused that code');

            const device = result.data.device || {};
            await keep({ ...record, deviceId: device.id, deviceName: device.name });
            remember(result.data.session?.token || null);
            return device;
        },

        /**
         * A session for the key this browser holds.
         *
         * Asked for when there is none, and again whenever the server stops accepting the
         * one in hand. A session is signed rather than stored, so it expires on its own;
         * the key is what outlives it, and it never leaves this browser to be renewed.
         */
        async session() {
            if (!supported) return '';
            const record = await held();
            if (!record?.deviceId) return '';

            const challenge = await post('/api/auth/challenge', { deviceId: record.deviceId });
            if (!challenge.ok) throw complain(challenge, 'The server would not set a challenge');

            // The bytes the service verifies: the app's `canonicalBytes`, character for
            // character, including where the newlines are and where they are not.
            const message = new TextEncoder().encode(
                `crossbar-device-auth-v1\n${record.deviceId}\n`
                + `${challenge.data.challengeId}\n${challenge.data.nonce}`);
            const signature = await crypto.subtle.sign(
                { name: 'ECDSA', hash: 'SHA-256' }, record.privateKey, message);

            const exchange = await post('/api/auth/session', {
                deviceId: record.deviceId,
                challengeId: challenge.data.challengeId,
                signature: base64(derSignature(signature)),
            });
            if (!exchange.ok) throw complain(exchange, 'The server would not accept the signature');

            remember(exchange.data.session?.token || null);
            return heldToken();
        },

        /** Forgets the key and the session: what forgetting this browser means from here. */
        async forget() {
            remember(null);
            await withStore('readwrite', (store) => store.delete(RECORD)).catch(() => {});
        },
    };
})();
