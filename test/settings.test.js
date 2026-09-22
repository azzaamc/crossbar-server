'use strict';

// The settings an operator may change, and the ones they may not. Every rule here is one
// whose absence is either a server that will not start or a setting nobody should be able to
// reach from a browser.

const test = require('node:test');
const assert = require('node:assert/strict');

const { KNOBS, applyKnobs, validateKnob, knobFor } = require('../src/config');

const SAMPLE = [
    '# A deployment.',
    'HOST=127.0.0.1',
    'PORT=3003',
    'MAX_PARTICIPANTS=4',
    'ALLOW_SELF_CALLS=false',
    'CROSSBAR_SESSION_SECRET=keep-me',
    '',
].join('\n');

test('a setting is written where it already was, and nothing else moves', () => {
    const next = applyKnobs(SAMPLE, { MAX_PARTICIPANTS: '6' });
    assert.match(next, /^MAX_PARTICIPANTS=6$/m);
    assert.match(next, /^CROSSBAR_SESSION_SECRET=keep-me$/m);
    assert.match(next, /^HOST=127\.0\.0\.1$/m);
    assert.equal(next.split('MAX_PARTICIPANTS=').length - 1, 1, 'written in place, not appended');
});

test('a setting the file does not have yet is added, not dropped', () => {
    assert.match(applyKnobs(SAMPLE, { CALL_RING_SECONDS: '120' }), /^CALL_RING_SECONDS=120$/m);
});

test('a value outside its range is refused, and says what the range is', () => {
    assert.throws(() => applyKnobs(SAMPLE, { MAX_PARTICIPANTS: '99' }), /between 2 and 8/);
    assert.throws(() => applyKnobs(SAMPLE, { MAX_PARTICIPANTS: 'lots' }), /whole number/);
    assert.throws(() => applyKnobs(SAMPLE, { ICE_STUN_URL: 'somewhere-nearby' }), /stun:host:port/);
});

test('a boolean is written the way the file spells it', () => {
    assert.match(applyKnobs(SAMPLE, { ALLOW_SELF_CALLS: true }), /^ALLOW_SELF_CALLS=true$/m);
    assert.match(applyKnobs(SAMPLE, { ALLOW_SELF_CALLS: 'off' }), /^ALLOW_SELF_CALLS=false$/m);
});

test('nothing that could lock somebody out is on the list', () => {
    const forbidden = ['HOST', 'PORT', 'PUBLIC_ORIGIN', 'CROSSBAR_PUBLIC_HOSTNAME', 'CROSSBAR_BIND_ADDRESS',
        'CROSSBAR_SESSION_SECRET', 'CROSSBAR_ADMIN_PASSWORD_HASH', 'CROSSBAR_TURN_SHARED_SECRET',
        'DATA_DIR', 'FAMILY_CONFIG_PATH', 'NODE_ENV', 'CROSSBAR_REQUIRE_DEVICE_AUTH', 'TRUST_TAILSCALE_HEADERS'];
    for (const key of forbidden) {
        assert.equal(knobFor(key), null, `${key} must not be writable from the console`);
        assert.throws(() => applyKnobs(SAMPLE, { [key]: 'anything' }), /may change/, key);
    }
});

test('every knob is described well enough to be rendered, and accepts its own bounds', () => {
    for (const knob of KNOBS) {
        assert.ok(knob.label && knob.label.length > 3, `${knob.key} needs a label`);
        assert.ok(['integer', 'boolean', 'text', 'url'].includes(knob.type), `${knob.key} has an odd type`);
        if (knob.type === 'integer') {
            assert.ok(knob.min < knob.max, `${knob.key} has an empty range`);
            assert.doesNotThrow(() => validateKnob(knob, String(knob.min)), `${knob.key} refuses its own minimum`);
            assert.throws(() => validateKnob(knob, String(knob.max + 1)), `${knob.key} accepts past its maximum`);
        }
    }
});
