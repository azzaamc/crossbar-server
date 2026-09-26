'use strict';

// The prompt renderer, at the two ends that can be reached without a terminal: the frames, which
// are pure enough to compare character for character, and the keys, which are driven through a
// scripted stream standing in for a person.
//
// What is *not* here is the look. Whether the arrow keys move the pointer on a real screen, whether
// the cursor lands where the next question starts, whether a spinner animates: none of that is
// visible from inside a pipe, and a test that claimed to check it would be checking the escape
// sequences it happens to emit. That is what a PTY is for.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const {
    createPrompter, createPresentation, NoTerminal, PLAIN, frames, stroke, steps,
} = require('../src/prompt');

/** A stream that is a terminal as far as the renderer is concerned, and a person who types. */
function terminal(t) {
    const input = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (raw) => { input.isRaw = raw; };
    const output = new PassThrough();
    output.isTTY = true;
    output.columns = 80;
    let written = '';
    output.on('data', (chunk) => { written += chunk; });
    t.after(() => { input.destroy(); output.destroy(); });
    return {
        input,
        output,
        ui: createPrompter({ input, output, interval: 100000 }),
        /** Everything the terminal has been sent, escape sequences and all. */
        written: () => written,
        /** The same with the cursor moves taken out, which is what a person would have seen. */
        seen: () => written.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, ''),
    };
}

/** One key at a time, each on its own tick, the way a keyboard delivers them. */
async function press(input, ...keys) {
    for (const key of keys) {
        input.write(key);
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

/** A question, run beside the keys that answer it. */
async function answer(where, question, ...keys) {
    const [settled] = await Promise.all([question(where.ui), press(where.input, ...keys)]);
    return settled;
}

const MENU = {
    message: 'Which modes is this deployment reached in?',
    options: [
        { value: 'private', label: 'Private', hint: 'the tailnet' },
        { value: 'public', label: 'Public' },
        { value: 'both', label: 'Both' },
    ],
};

test('the frames are the ones a Clack prompt draws', () => {
    // Character for character, since this is the whole of the look: the `┌` an interaction opens
    // with, the `│` that guides it, the symbols that say which state a question is in, and the
    // `└` it closes with.
    assert.equal(frames.opening('Crossbar setup', PLAIN), '┌  Crossbar setup');
    assert.deepEqual(frames.closing('Set up.', PLAIN), ['│', '└  Set up.']);

    const question = { message: 'the tailnet name', placeholder: 'house.tailnet.ts.net', paint: PLAIN };
    const waiting = { value: '', caret: 0, problem: '', settled: null };
    assert.deepEqual(frames.textFrame(waiting, question), [
        '│',
        '◆  the tailnet name',
        '│  house.tailnet.ts.net',
        '└',
    ]);
    assert.deepEqual(frames.textFrame({ ...waiting, value: 'house', caret: 5, settled: 'submitted' }, question), [
        '│',
        '◇  the tailnet name',
        '│  house',
    ]);
    // A refusal keeps the question and the input, and says what is wrong under it: the field is
    // still there to be corrected, which is what makes it a re-ask rather than a failure.
    assert.deepEqual(frames.textFrame({ ...waiting, value: '0.0.0.0', problem: 'Nothing may bind 0.0.0.0.' }, question), [
        '│',
        '▲  the tailnet name',
        '│  0.0.0.0',
        '└  Nothing may bind 0.0.0.0.',
    ]);

    // The menu: a pointer on the option the arrow keys are on, a hint beside it in brackets, and
    // the keys that move it written under the list.
    assert.deepEqual(frames.selectFrame({ cursor: 0, settled: null }, { message: MENU.message, options: MENU.options, paint: PLAIN }), [
        '│',
        '◆  Which modes is this deployment reached in?',
        '│  ● Private (the tailnet)',
        '│  ○ Public',
        '│  ○ Both',
        '│  ↑/↓ to navigate • Enter: confirm',
        '└',
    ]);
    assert.deepEqual(
        frames.selectFrame({ cursor: 1, settled: 'submitted' }, { message: MENU.message, options: MENU.options, paint: PLAIN }).at(-1),
        '│  Public',
    );

    assert.deepEqual(frames.confirmFrame({ value: false, settled: null }, { message: 'another person?', paint: PLAIN }), [
        '│',
        '◆  another person?',
        '│  ○ Yes / ● No',
        '└',
    ]);
});

test('the frames carry the paint when there is a terminal to carry it to', () => {
    // The dim hints and the coloured symbols are the look as much as the glyphs are, so the codes
    // are asserted here rather than left to the eye: green `◇` for what was submitted, cyan `◆`
    // for what is being asked, dim for what is only a hint.
    const submitted = frames.textFrame({ value: 'house', caret: 5, settled: 'submitted' }, { message: 'name' });
    assert.match(submitted[1], /^\u001b\[32m◇\u001b\[39m {2}name$/);
    const waiting = frames.textFrame({ value: '', caret: 0, problem: '', settled: null }, { message: 'name', placeholder: 'house' });
    assert.match(waiting[1], /^\u001b\[36m◆\u001b\[39m {2}name$/);
    // The caret's own character is turned about, and the rest of what is offered is dimmed.
    assert.equal(waiting[2], '\u001b[36m│\u001b[39m  \u001b[7mh\u001b[27m\u001b[2mouse\u001b[22m');
});

test('the box is square, whatever it is asked to hold', () => {
    const lines = frames.boxed(
        'Modes      private, public (in force: private)\n\n◇ STUN     the internet sees 203.0.113.7:443',
        'Crossbar setup',
        PLAIN,
        40,
    );
    // Every line of the box the same width, which is the whole point of drawing one: guides that
    // line up are what make it read as a box and not as a wall of text. The bare `│` above it is
    // the guide the box hangs off, and is deliberately not one of its lines.
    assert.equal(new Set(lines.slice(1).map((line) => line.length)).size, 1, lines.join('\n'));
    assert.match(lines[1], /^◇ {2}Crossbar setup ─+╮$/);
    assert.match(lines.at(-1), /^├─+╯$/);
    // As wide as it needs to be and no wider, so a narrow screen gets a box that fits on it.
    assert.ok(new Set(lines.slice(1).map((line) => line.length)).size === 1);
    assert.ok(lines[1].length <= 40, lines[1].length);
});

test('a menu wraps at both ends, and settles on the option the pointer is on', async (t) => {
    const up = terminal(t);
    // One press up from the first option: the pointer leaves the top and arrives at the bottom.
    const wrapped = await answer(up, (ui) => ui.select({ ...MENU, initial: 'private' }), '\x1b[A', '\r');
    assert.equal(wrapped, 'both');
    assert.match(up.seen(), /│  ○ Private \(the tailnet\)\n│  ○ Public\n│  ● Both/);
    assert.match(up.seen(), /◇  Which modes is this deployment reached in\?\n│  Both/);

    const down = terminal(t);
    // And one press down from the last arrives at the first, so the pointer has nowhere to stop.
    const around = await answer(down, (ui) => ui.select({ ...MENU, initial: 'both' }), '\x1b[B', '\r');
    assert.equal(around, 'private');
    assert.match(down.seen(), /│  ● Private \(the tailnet\)\n│  ○ Public\n│  ○ Both/);
});

test('a field that refuses asks again, with what was typed still in it', async (t) => {
    const where = terminal(t);
    const refusing = (value) => (value === '0.0.0.0' ? 'Nothing may bind 0.0.0.0: tailscaled holds it.' : undefined);

    const asked = where.ui.text({ message: 'the address Caddy binds', placeholder: '203.0.113.7', validate: refusing });
    await press(where.input, '0.0.0.0', '\r');
    // Refused: the question is still the active one, the wildcard is still on the line, and the
    // reason is under it — not a thrown error, and not an accepted answer.
    assert.match(where.seen(), /▲  the address Caddy binds\n│  0\.0\.0\.0\n└  Nothing may bind 0\.0\.0\.0: tailscaled holds it\./);
    // Edited down to something bindable, and the same field settles.
    await press(where.input, '\u007f\u007f\u007f\u007f\u007f\u007f', '\r');
    assert.equal(await asked, '0');
    assert.match(where.seen(), /◇  the address Caddy binds\n│  0\n/);
});

test('a field takes the default it is showing when Enter is pressed', async (t) => {
    const where = terminal(t);
    const value = await answer(where, (ui) => ui.text({
        message: 'the tailnet name',
        placeholder: 'house.tailnet.ts.net',
        defaultValue: 'house.tailnet.ts.net',
    }), '\r');
    assert.equal(value, 'house.tailnet.ts.net');
    // The default was on the screen before Enter — that is what "shown" means — and it was the
    // placeholder, so it reads as offered rather than as typed.
    assert.match(where.seen(), /◆  the tailnet name\n│  house\.tailnet\.ts\.net\n└/);
    assert.match(where.seen(), /◇  the tailnet name\n│  house\.tailnet\.ts\.net/);
});

test('a yes-or-no question answers to y, n, the arrow keys and Enter', async (t) => {
    assert.equal(await answer(terminal(t), (ui) => ui.confirm({ message: 'an administrator?' }), 'y'), true);
    assert.equal(await answer(terminal(t), (ui) => ui.confirm({ message: 'another person?', initialValue: false }), '\r'), false);
    assert.equal(await answer(terminal(t), (ui) => ui.confirm({ message: 'another person?', initialValue: false }), '\x1b[D', '\r'), true);
});

test('a keypress means what Clack means by it, and a field takes what a person types', () => {
    assert.equal(stroke('\u0003', { name: 'c', ctrl: true }).name, 'cancel');
    assert.equal(stroke('\u001b', { name: 'escape' }).name, 'cancel');
    assert.equal(stroke('', { name: 'return' }).name, 'enter');
    assert.equal(stroke('', { name: 'up' }).name, 'up');
    assert.equal(stroke('x', { name: 'x' }).name, 'char');

    // A field is edited, not navigated: `j` and `k` are letters there even though they walk a menu.
    assert.equal(stroke('j', { name: 'j' }).char, 'j');
    assert.equal(steps.selectStep({ cursor: 0, settled: null }, MENU.options, stroke('k', { name: 'k' })).cursor, 2);
    assert.equal(steps.selectStep({ cursor: 0, settled: null }, MENU.options, stroke('j', { name: 'j' })).cursor, 1);

    const typed = steps.textStep({ value: 'ho', caret: 2, problem: '', settled: null }, stroke('u', { name: 'u' }));
    assert.deepEqual(typed, { value: 'hou', caret: 3, problem: '', settled: null });
    // Backspace, and a move left for the caret — the whole of the editing a one-line field needs.
    assert.equal(steps.textStep(typed, stroke('', { name: 'backspace' })).value, 'ho');
    assert.equal(steps.textStep(typed, stroke('', { name: 'left' })).caret, 2);
});

test('a run with no terminal is refused, and nothing is written anywhere', () => {
    const written = [];
    // Not a terminal on either end: an empty stream is exactly what a pipe, a file and a service's
    // stdin all look like, and the one thing none of them can be asked a question through.
    const bare = createPrompter({
        input: Object.assign(new PassThrough(), { isTTY: false, setRawMode: () => {} }),
        output: Object.assign(new PassThrough(), { isTTY: false, write: (text) => written.push(text) }),
    });
    assert.equal(bare.present, false);
    for (const method of ['intro', 'outro', 'note', 'select', 'text', 'confirm', 'spinner']) {
        assert.throws(() => bare[method]({ message: 'anything' }), NoTerminal, method);
    }
    // Nothing drawn at all: a refusal that painted a frame first would have put escape sequences
    // into whatever the log is, which is the failure this whole branch exists to avoid.
    assert.deepEqual(written, []);

    // The same frames for a log, with none of the sequences in them.
    const lines = [];
    const plain = createPresentation({ write: (line) => lines.push(line), columns: 40 });
    plain.intro('Crossbar setup');
    plain.note('Modes      private, public', 'Crossbar setup');
    plain.outro('Set up.');
    assert.ok(lines.length > 3);
    assert.equal(lines.some((line) => line.includes('\u001b')), false);
    assert.equal(lines[0], '┌  Crossbar setup');
    assert.equal(lines.at(-2), '└  Set up.');
});
