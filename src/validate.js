'use strict';

// Payload validation for signalling events.
//
// Every event has a closed schema: required keys must be present and the right
// type, optional keys are bounded, and unknown keys are dropped rather than
// forwarded. Nothing here trusts a field that also appears in server state — ids
// supplied by a client are matched against what the server recorded, never used
// as a key on their own.
//
// The previous implementation validated the two most dangerous events with "is a
// non-empty object". These functions exist so that is not true here.

const PEER_STATUS_ELEMENTS = new Set(['video', 'audio', 'screen', 'hand', 'rec', 'privacy']);

class Invalid extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(object, key, { max, label = key } = {}) {
    const value = object[key];
    if (typeof value !== 'string') throw new Invalid(`${label}_not_a_string`);
    const trimmed = value.trim();
    if (!trimmed) throw new Invalid(`${label}_empty`);
    if (max && trimmed.length > max) throw new Invalid(`${label}_too_long`);
    return trimmed;
}

function optionalString(object, key, { max } = {}) {
    const value = object[key];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new Invalid(`${key}_not_a_string`);
    const trimmed = value.trim();
    if (max && trimmed.length > max) throw new Invalid(`${key}_too_long`);
    return trimmed;
}

function optionalBool(object, key, fallback = false) {
    const value = object[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') throw new Invalid(`${key}_not_a_boolean`);
    return value;
}

/**
 * `join` — admission. `channel` is the room the caller claims to be in; it is
 * checked against a call the caller is actually a participant of.
 */
function validateJoin(payload) {
    if (!isPlainObject(payload)) throw new Invalid('payload_not_an_object');
    const peerInfo = isPlainObject(payload.peer_info) ? payload.peer_info : {};
    return {
        channel: requireString(payload, 'channel', { max: 64 }),
        peerUuid: requireString(payload, 'peer_uuid', { max: 64 }),
        peerName: requireString(payload, 'peer_name', { max: 80 }),
        peerAvatar: optionalString(payload, 'peer_avatar', { max: 500 }),
        video: optionalBool(payload, 'peer_video', true),
        audio: optionalBool(payload, 'peer_audio', true),
        videoStatus: optionalBool(payload, 'peer_video_status', true),
        audioStatus: optionalBool(payload, 'peer_audio_status', true),
        screenStatus: optionalBool(payload, 'peer_screen_status', false),
        os: optionalString(peerInfo, 'osName', { max: 64 }),
        browser: optionalString(peerInfo, 'browserName', { max: 64 }),
    };
}

/** `relaySDP` — offer/answer, relayed verbatim but bounded and shaped. */
function validateRelaySdp(payload, { maxSdpBytes }) {
    if (!isPlainObject(payload)) throw new Invalid('payload_not_an_object');
    const description = payload.session_description;
    if (!isPlainObject(description)) throw new Invalid('session_description_missing');
    const type = description.type;
    if (type !== 'offer' && type !== 'answer') throw new Invalid('session_description_type_invalid');
    const sdp = description.sdp;
    if (typeof sdp !== 'string' || !sdp) throw new Invalid('sdp_missing');
    if (sdp.length > maxSdpBytes) throw new Invalid('sdp_too_long');
    if (!sdp.startsWith('v=')) throw new Invalid('sdp_not_sdp');
    return {
        peerId: requireString(payload, 'peer_id', { max: 64 }),
        description: { type, sdp },
    };
}

/** `relayICE` — a single trickled candidate. */
function validateRelayIce(payload, { maxIceBytes }) {
    if (!isPlainObject(payload)) throw new Invalid('payload_not_an_object');
    const candidate = payload.ice_candidate;
    if (!isPlainObject(candidate)) throw new Invalid('ice_candidate_missing');
    const value = candidate.candidate;
    if (typeof value !== 'string' || !value) throw new Invalid('candidate_missing');
    if (value.length > maxIceBytes) throw new Invalid('candidate_too_long');
    if (!value.startsWith('candidate:')) throw new Invalid('candidate_not_a_candidate');
    const index = candidate.sdpMLineIndex ?? 0;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 32) {
        throw new Invalid('sdp_mline_index_invalid');
    }
    return {
        peerId: requireString(payload, 'peer_id', { max: 64 }),
        candidate: { sdpMLineIndex: index, candidate: value },
    };
}

/**
 * `peerStatus` — a peer's own media status. The identity fields are returned so the
 * caller can check them against what the server recorded; they are not trusted.
 */
function validatePeerStatus(payload) {
    if (!isPlainObject(payload)) throw new Invalid('payload_not_an_object');
    const element = payload.element;
    if (typeof element !== 'string' || !PEER_STATUS_ELEMENTS.has(element)) {
        throw new Invalid('element_invalid');
    }
    if (typeof payload.status !== 'boolean') throw new Invalid('status_not_a_boolean');
    let extras = {};
    if (payload.extras !== undefined && payload.extras !== null) {
        if (!isPlainObject(payload.extras)) throw new Invalid('extras_not_an_object');
        extras = payload.extras;
    }
    return {
        roomId: requireString(payload, 'room_id', { max: 64 }),
        peerId: requireString(payload, 'peer_id', { max: 64 }),
        peerName: requireString(payload, 'peer_name', { max: 80 }),
        element,
        status: payload.status,
        extras,
    };
}

module.exports = {
    Invalid,
    PEER_STATUS_ELEMENTS,
    validateJoin,
    validateRelaySdp,
    validateRelayIce,
    validatePeerStatus,
    isPlainObject,
};
