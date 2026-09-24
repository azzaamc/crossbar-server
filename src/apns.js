'use strict';

// APNs, for ringing a phone that is asleep.
//
// A browser can be rung by Web Push because a service worker is woken to show a
// notification. iOS has nothing equivalent: a suspended app is woken by nothing at all
// except a VoIP push, and since iOS 13 the app must report the call to CallKit inside the
// push handler or the system terminates it and throttles its pushes afterwards.
//
// That requirement is why this carries the whole call in the payload. The device cannot
// ask a question before it has to answer the system, so everything it needs to draw an
// incoming call — who is calling, which call, what kind — travels with the push. It
// authenticates and joins afterwards, when somebody has actually answered.
//
// Delivery is disabled when no key is configured, and says so, which is the same rule the
// browser notifier follows. There is no fallback that pretends to deliver.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http2 = require('node:http2');

/** Where a device's token is valid. A token issued by a debug build is not valid here. */
const HOSTS = Object.freeze({
    sandbox: 'https://api.sandbox.push.apple.com',
    production: 'https://api.push.apple.com',
});

/** The largest payload Apple accepts for a VoIP push. Ours is a few hundred bytes. */
const PAYLOAD_LIMIT = 5120;

/**
 * Apple's provider token: an ES256 JWT over the `.p8` key, which is the whole of the
 * authentication. Nothing here is a secret that travels — the signature is.
 */
function providerToken({ keyId, teamId, privateKey, now }) {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) })).toString('base64url');
    const signing = `${header}.${claims}`;
    // `ieee-p1363` is most of the reason this is written out rather than handed to a JWT
    // library: a JOSE signature is the raw r‖s pair, and Node's default is the DER
    // sequence, which Apple rejects without saying anything more useful than that.
    const signature = crypto.sign('sha256', Buffer.from(signing), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    return `${signing}.${signature}`;
}

/** The `.p8`, from a file if one is named. A key that cannot be read leaves this disabled. */
function readKey({ apnsKey, apnsKeyPath, log }) {
    if (apnsKey) return apnsKey.replaceAll('\\n', '\n');
    if (!apnsKeyPath) return '';
    try {
        return fs.readFileSync(apnsKeyPath, 'utf8');
    } catch (error) {
        // Loud, because an operator who configured a key and then got silence would look
        // for the fault in the wrong place: everything else about the deployment works.
        log.warn('apns_key_unreadable', { path: apnsKeyPath, message: String(error.message).slice(0, 120) });
        return '';
    }
}

/**
 * The real transport: one HTTP/2 session per host, kept open between pushes.
 *
 * A call is a latency-sensitive moment and APNs expects a session rather than a connection
 * per push, so a session that has died — Apple closes idle ones — is dropped and replaced
 * on the next push rather than being reconnected around.
 *
 * It is a separate thing from the notifier so that the request the notifier builds can be
 * checked without Apple. Everything in that request that is ours, rather than Node's or
 * Apple's, is also the part that fails silently: a wrong topic or push type is a phone
 * that simply never rings.
 */
function httpTransport() {
    const sessions = new Map();

    function sessionFor(origin) {
        const held = sessions.get(origin);
        if (held && !held.closed && !held.destroyed) return held;
        const opened = http2.connect(origin);
        opened.on('error', () => sessions.delete(origin));
        opened.on('close', () => sessions.delete(origin));
        sessions.set(origin, opened);
        return opened;
    }

    function send(origin, path, headers, body) {
        return new Promise((resolve, reject) => {
            const request = sessionFor(origin).request({ ':method': 'POST', ':path': path, ...headers });
            let status = 0;
            let payload = '';
            request.on('response', (received) => { status = received[':status'] || 0; });
            request.setEncoding('utf8');
            request.on('data', (chunk) => { payload += chunk; });
            request.on('end', () => resolve({ status, payload }));
            request.on('error', reject);
            request.end(body);
        });
    }

    function close() {
        for (const session of sessions.values()) session.close();
        sessions.clear();
    }

    return { send, close };
}

function createApnsNotifier({ config, log, transport = httpTransport() }) {
    const privateKey = readKey({ ...config, log });
    const enabled = Boolean(privateKey && config.apnsKeyId && config.apnsTeamId && config.apnsTopic);
    // Two topics, because the topic is what decides which part of the app iOS wakes: a
    // PushKit registry may only ever be sent on `.voip`, and a notification on the bundle id
    // itself. Sending a call on the wrong one is a push nobody handles.
    const voipTopic = `${config.apnsTopic}.voip`;
    const alertTopic = config.apnsTopic;

    // Apple rejects a provider token older than an hour, and asks that it not be refreshed
    // more than once every twenty minutes. Forty-five sits inside both.
    let held = { value: '', at: 0 };
    function token() {
        const now = Date.now();
        if (held.value && now - held.at < 45 * 60 * 1000) return held.value;
        held = {
            value: providerToken({
                keyId: config.apnsKeyId,
                teamId: config.apnsTeamId,
                privateKey,
                now,
            }),
            at: now,
        };
        return held.value;
    }

    /**
     * One device, with the reason it could not be reached when that is worth acting on.
     *
     * One function for both kinds of push, because the difference between them is entirely
     * in the shape — which topic, which part of the app, what is inside — and everything
     * else about delivering one is the same.
     */
    async function deliver(device, shape) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            let answer;
            try {
                answer = await transport.send(
                    HOSTS[device.environment] || HOSTS.production,
                    `/3/device/${device.token}`,
                    {
                        authorization: `bearer ${token()}`,
                        'apns-topic': shape.topic,
                        'apns-push-type': shape.pushType,
                        // Both kinds are things a person is waiting to find out about — a call
                        // that is ringing, or one they missed — so neither is sent at the
                        // lower priority a background fetch would use.
                        'apns-priority': '10',
                        'apns-expiration': String(shape.expiration),
                        'apns-id': crypto.randomUUID(),
                        ...(shape.collapseId ? { 'apns-collapse-id': shape.collapseId } : {}),
                    },
                    shape.body,
                );
            } catch (error) {
                log.warn('apns_unreachable', { message: String(error.message).slice(0, 120) });
                return { ok: false };
            }
            if (answer.status === 200) return { ok: true };

            let reason = '';
            try {
                reason = JSON.parse(answer.payload || '{}').reason || '';
            } catch {
                // A body that is not the documented shape is still a refusal. The status is
                // the part that is always there.
            }
            // The one refusal worth another go: Apple does not promise a provider token its
            // full hour, and says so by name when it has not had it.
            if (reason === 'ExpiredProviderToken' && attempt === 0) {
                held = { value: '', at: 0 };
                continue;
            }
            // The device is gone rather than unreachable, so the token is no longer worth
            // keeping and the caller clears the row it came from.
            if (reason === 'Unregistered' || reason === 'BadDeviceToken') return { drop: true, reason };
            log.warn('apns_refused', { status: answer.status, reason, environment: device.environment });
            return { ok: false, reason };
        }
        return { ok: false };
    }

    /**
     * Rings every device in `devices`, and answers with the ones whose token is dead.
     *
     * Only a ringing call uses this. The payload is shaped for CallKit rather than for a
     * notification, because a VoIP push is not shown to anybody: the call on the screen is
     * drawn by the app, out of what travels here.
     */
    async function incoming(devices, call, callerName) {
        if (!enabled || !devices.length) return [];

        const expiresAt = Date.parse(call.createdAt) + config.callRingSeconds * 1000;
        const body = JSON.stringify({
            // Required for delivery, and carrying nothing to show. A VoIP push is not a
            // notification — it is handed to the app and drawn by CallKit out of the keys
            // below — so this is the shape that asks for no user-visible alert. An `alert`
            // here would be a second thing claiming the same attention as the ring.
            aps: { 'content-available': 1 },
            callId: call.id,
            kind: call.kind === 'audio' ? 'audio' : 'video',
            caller: callerName,
            callerId: call.callerId,
            expiresAt: new Date(expiresAt).toISOString(),
        });
        if (Buffer.byteLength(body) > PAYLOAD_LIMIT) {
            log.warn('apns_payload_too_large', { callId: call.id, bytes: Buffer.byteLength(body) });
            return [];
        }

        const expiration = Math.floor(expiresAt / 1000);
        return fanOut(devices, { topic: voipTopic, pushType: 'voip', body, expiration });
    }

    /** Every device in parallel, answering with the ones whose token is dead. */
    async function fanOut(devices, shape) {
        const dead = [];
        await Promise.all(devices.map(async (device) => {
            const outcome = await deliver(device, shape);
            if (outcome.drop) {
                dead.push(device);
                log.info('apns_token_dropped', { deviceId: device.deviceId, reason: outcome.reason });
            }
        }));
        return dead;
    }

    /**
     * A call that was missed, as an ordinary notification.
     *
     * This is the other way round from a ring. Nobody is waiting for it and the app may never
     * be opened, so the whole point is a line on a lock screen — which means the notification
     * system, the bundle id topic, and a token that is not the VoIP one. It must never
     * present as an incoming call: the call is over, and an answer button for it would be a
     * lie.
     */
    async function alert(devices, { callId, title, body }) {
        if (!enabled || !devices.length) return [];

        const payload = JSON.stringify({
            aps: { alert: { title, body }, sound: 'default' },
            callId,
        });
        return fanOut(devices, {
            topic: alertTopic,
            pushType: 'alert',
            // One per call, so a second push about the same missed call replaces the first
            // rather than stacking a second line saying the same thing.
            collapseId: `missed-${callId}`,
            // Worth knowing about for a while, and noise after that: an afternoon-old
            // "somebody called" is not worth waking a phone for.
            expiration: Math.floor(Date.now() / 1000) + 3600,
            body: payload,
        });
    }

    return { enabled, topic: voipTopic, incoming, alert, close: transport.close };
}

module.exports = { createApnsNotifier, providerToken, httpTransport };
