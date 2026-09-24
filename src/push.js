'use strict';

// Web Push for browser clients. A closed PWA can only be rung by a push, so this is
// the difference between "the call rings" and "the call was missed".
//
// Delivery is disabled — and says so through `/api/push/config` — when no VAPID key
// pair is configured. There is no fallback that pretends to deliver.

const webPush = require('web-push');

function createPushNotifier({ config, log }) {
    const enabled = Boolean(config.vapidPublicKey && config.vapidPrivateKey);
    const ttl = config.callRingSeconds;

    if (enabled) {
        const subject = config.vapidSubject
            || (config.publicOrigin.startsWith('https:') ? config.publicOrigin : 'mailto:family-call@localhost.invalid');
        webPush.setVapidDetails(subject, config.vapidPublicKey, config.vapidPrivateKey);
    }

    async function incoming(subscriptions, call, callerName) {
        if (!enabled || !subscriptions.length) return [];
        const payload = JSON.stringify({
            type: 'incoming-call',
            callId: call.id,
            title: 'Incoming call',
            body: `${callerName} is calling`,
        });
        const stale = [];
        await Promise.all(subscriptions.map(async (subscription) => {
            try {
                await webPush.sendNotification(subscription, payload, {
                    TTL: ttl,
                    urgency: 'high',
                    topic: `call-${call.id.replaceAll('-', '').slice(0, 27)}`,
                });
            } catch (error) {
                if (error.statusCode === 404 || error.statusCode === 410) stale.push(subscription.endpoint);
                else log.warn('push_delivery_failed', { statusCode: error.statusCode || null });
            }
        }));
        return stale;
    }

    return { enabled, publicKey: enabled ? config.vapidPublicKey : '', incoming };
}

module.exports = { createPushNotifier };
