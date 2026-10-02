'use strict';

// The prompt renderer, at the two ends that can be reached without a terminal: the frames, which
// are pure enough to compare character for character, and the keys, which are driven through a
// scripted stream standing in for a person.
//
// What is *not* here is the look: whether the arrow keys move the pointer on a real screen, whether
// a spinner animates. A test that claimed to check those from inside a pipe would be checking the
// escape sequences it happens to emit.
//
// One thing about a real screen *is* here, because a pipe can be held to it: `screenOf` replays what
// was written the way a terminal would — a cursor, a row per line, and a character written past the
// last column going on to the next row — so a frame is asserted against the screen it leaves rather
// than against the sequences that drew it. That is the failure a wrapped question caused: it draws on
// more rows than its lines, a redraw that moved up by the lines then began a row lower every time,
// and the sequences alone look exactly as intended. The measurement itself was made in tmux, which is
// the instrument for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const {
    createPrompter, createPresentation, NoTerminal, PLAIN, frames, stroke, steps,
} = require('../src/prompt');

/** A stream that is a terminal as far as the renderer is concerned, and a person who types. */
function terminal(t, columns = 80) {
    const input = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (raw) => { input.isRaw = raw; };
    const output = new PassThrough();
    output.isTTY = true;
    output.columns = columns;
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

/**
 * The screen a terminal would be holding, given everything that was written to it: a cursor, a row
 * per line, and the four things this renderer writes — carriage return, line feed, a cursor moved up,
 * and the erase below it. A character written past the last column goes on to the next row, which is
 * the whole point of modelling it: the terminal wraps a line the renderer counted as one.
 */
function screenOf(written, columns) {
    const rows = [[]];
    let row = 0;
    let col = 0;
    const at = (index) => { while (rows.length <= index) rows.push([]); return rows[index]; };
    const escape = /\u001b\[([0-9;?]*)([A-Za-z])/y;
    for (let cursor = 0; cursor < written.length;) {
        escape.lastIndex = cursor;
        const found = escape.exec(written);
        if (found) {
            const [, numbers, letter] = found;
            if (letter === 'A') row = Math.max(0, row - (Number(numbers) || 1));
            if (letter === 'J' && (numbers === '0' || numbers === '')) {
                at(row).length = col;
                rows.length = row + 1;
            }
            cursor = escape.lastIndex;
            continue;
        }
        const char = written[cursor];
        cursor += 1;
        if (char === '\r') { col = 0; continue; }
        if (char === '\n') { row += 1; continue; }
        at(row)[col] = char;
        col += 1;
        if (col >= columns) { col = 0; row += 1; }
    }
    const lines = rows.map((line) => line.join('').trimEnd());
    while (lines.length > 1 && lines.at(-1) === '') lines.pop();
    return lines;
}

/** The question the report was made at: wider than a screen once the `◆` is put in front of it. */
const QUESTION = 'The first person: the short id the console knows them by (for example: abdullah)';

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

test('a frame occupies as many rows as the screen wraps it onto', () => {
    // A row per line, and a row more for every line too wide for the screen. Counting lines instead
    // is what walked the prompt down the screen: the question below draws on two rows at eighty
    // columns and three at forty, so a redraw that moved up by the four lines it counted rather than
    // the five or six rows it drew began lower on the screen every time.
    assert.equal(frames.rows(['│', '◆  a', '│  b', '└'], 80), 4);
    assert.equal(frames.rows(['', 'a'], 40), 2);
    // A line ending exactly at the last column has not wrapped yet — the terminal wraps when the
    // next character arrives — so a screen's worth of text is one row and not two. Measured in tmux:
    // a question of exactly forty columns stays on one row and the frame does not move off it.
    assert.equal(frames.rows(['x'.repeat(80)], 80), 1);
    assert.equal(frames.rows(['x'.repeat(40)], 40), 1);
    assert.equal(frames.rows(['x'.repeat(41)], 40), 2);
    assert.equal(frames.rows(['x'.repeat(80)], 40), 2);

    const frame = frames.textFrame(
        { value: 'ab', caret: 2, problem: '', settled: null },
        { message: QUESTION, placeholder: 'abdullah', paint: PLAIN },
    );
    assert.equal(frame.length, 4);
    assert.equal(frames.rows(frame, 80), 5);
    assert.equal(frames.rows(frame, 40), 6);
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

test('a question wider than the screen redraws in place instead of walking down it', async (t) => {
    // Forty columns, where the question wraps onto three rows: the frame is six rows of screen.
    // Before the fix the redraw moved up by the four *lines* it counted and left two of the six
    // behind, so three keypresses put the frame six rows down the screen with a `│` and a half
    // question stranded above it — the report, exactly.
    const where = terminal(t, 40);
    const asked = where.ui.text({ message: QUESTION, placeholder: 'abdullah' });

    await press(where.input, 'a', 'b', 'c');
    assert.deepEqual(screenOf(where.written(), 40), [
        '│',
        '◆  The first person: the short id the co',
        'nsole knows them by (for example: abdull',
        'ah)',
        '│  abc',
        '└',
    ]);

    // And it is still the question, not a frame that settled over itself: the same screen holds what
    // is typed next.
    await press(where.input, 'd', '\r');
    assert.equal(await asked, 'abcd');
});

test('a resize mid-question is measured at the width the screen was left at', async (t) => {
    const where = terminal(t);
    const asked = where.ui.text({ message: QUESTION, placeholder: 'abdullah' });

    // Eighty columns: the question wraps onto two rows, so the frame is five and the cursor it left
    // comes back up four.
    await press(where.input, 'a');
    assert.ok(where.written().includes('\u001b[4A'), where.seen());

    // Narrowed to forty, the terminal rewraps what is already drawn — the frame is six rows on the
    // screen now — so the next redraw has to come up five. tmux, resized mid-question from eighty to
    // thirty-four, holds one frame in place after every further keypress at the new width.
    where.output.columns = 40;
    const mark = where.written().length;
    await press(where.input, 'b');
    assert.ok(where.written().slice(mark).includes('\u001b[5A'), where.written().slice(mark));
    // The redraw that follows is one frame and nothing else: the six rows it erased, drawn again at
    // the width it erased them at.
    assert.deepEqual(screenOf(where.written().slice(mark), 40), [
        '│',
        '◆  The first person: the short id the co',
        'nsole knows them by (for example: abdull',
        'ah)',
        '│  ab',
        '└',
    ]);

    await press(where.input, '\r');
    assert.equal(await asked, 'ab');
});

test('a spinner line the screen wraps is erased as the rows it drew on', (t) => {
    const where = terminal(t, 40);
    const spinning = where.ui.spinner();
    // The message does not fit in forty columns, so the spinner is drawn on two rows — and erased as
    // the one it was, the first of them stayed behind and every turn of the cycle added another. tmux
    // at thirty-four columns: a row per tick.
    spinning.start('Checking what this box looks like from outside');
    spinning.message('Checking what this box looks like from outside again');
    assert.deepEqual(screenOf(where.written(), 40), [
        '│',
        '◒  Checking what this box looks like fro',
        'm outside again',
    ]);
    spinning.stop('the checks are in the summary below');
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

test('the next step takes the previous one off the screen, and the last note stays', async (t) => {
    // The whole of requirement one: a question is a bounded area, and the question after it erases
    // that area rather than being printed under it. The screen holds the current step, not the
    // history of the run.
    const where = terminal(t);
    const first = where.ui.text({ message: 'the first question', defaultValue: 'one' });
    await press(where.input, '\r');
    assert.equal(await first, 'one');
    assert.deepEqual(screenOf(where.written(), 80), [
        '│',
        '◇  the first question',
        '│  one',
    ]);

    const second = where.ui.text({ message: 'the second question', defaultValue: 'two' });
    await press(where.input, '\r');
    assert.equal(await second, 'two');
    // One frame on the screen: the first question is nowhere in what a person is looking at.
    assert.deepEqual(screenOf(where.written(), 80), [
        '│',
        '◇  the second question',
        '│  two',
    ]);

    // A note between two questions is a step too: it replaces the question before it, and the
    // question after replaces it. Nothing of either is left above the last frame.
    const noted = terminal(t);
    const asked = noted.ui.text({ message: 'a question', defaultValue: 'x' });
    await press(noted.input, '\r');
    assert.equal(await asked, 'x');
    noted.ui.note('the derived id, said between two questions', 'The directory');
    const notedScreen = screenOf(noted.written(), 80);
    assert.match(notedScreen[1], /^◇  The directory ─+╮$/);
    assert.equal(notedScreen.some((line) => line.includes('a question')), false,
        `the question above the note is still there: ${notedScreen.join(' / ')}`);

    // The last note is a thing that stays: the outro after it is drawn under it rather than over
    // it, so the summary this wizard ends with is still on the screen.
    const summary = terminal(t);
    summary.ui.note('Modes      private', 'Crossbar setup');
    const afterNote = screenOf(summary.written(), 80);
    summary.ui.outro('Set up.');
    const afterOutro = screenOf(summary.written(), 80);
    assert.deepEqual(afterOutro.slice(0, afterNote.length), afterNote, 'the summary is still there');
    assert.equal(afterOutro.at(-1), '└  Set up.');

    // A command the wizard ran in this terminal takes the region with it: what it printed is not
    // the wizard's to erase, so `forget` stops accounting for it and the next step draws under it.
    // This is asserted on what was written and not on `screenOf`, whose model of a bare `\n` is not
    // a cooked terminal's (a note is drawn with the escape sequences and `\n`, which a terminal
    // translates to a carriage return as well — the frames a prompt draws use `\r\n` themselves).
    const afterACommand = terminal(t);
    afterACommand.ui.note('a note before the command', 'Before');
    const beforeForget = afterACommand.written().length;
    afterACommand.ui.forget();
    afterACommand.ui.note('a note after it', 'After');
    const between = afterACommand.written().slice(beforeForget);
    assert.equal(between.includes('\u001b[0J'), false, 'the region was erased after the command');
    assert.match(afterACommand.written(), /After/, 'the note after the command is missing');
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
