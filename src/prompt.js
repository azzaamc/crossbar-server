'use strict';

// The wizard's terminal, drawn the way `@clack/prompts` draws one and written out of the standard
// library alone.
//
// `install.sh` calls the wizard between the code copy and `npm ci`, which is before `node_modules`
// exists — and `npm ci --omit=dev` on a finished box installs nothing either — so a dependency is
// not available to it. The look is therefore reimplemented rather than imported: the same frames
// (`┌` opening, `│` guiding, `◆` waiting, `◇` submitted, `▲` refused, `└` closing), the same
// arrow-key menus with a pointer, the same dim hints, the same boxed note, the same spinner. The
// MIT-licensed original at github.com/bombshell-dev/clack is where the shapes were read from; no
// code is copied from it.
//
// Three pieces, kept apart so that the first two can be tested with no terminal in the room:
//
//   * `frames` — pure: one prompt's state in, the lines to draw out.
//   * `stroke` — pure: one keypress in, what it means to the prompt that is listening.
//   * `createPrompter` — the streams, the raw mode, and the frames written in the order they
//     happen.
//
// Nothing here prompts without a terminal. Escape sequences written into a log file are worse than
// a refusal, and there is nobody at the other end of them to read the question — so a prompter
// with no terminal says so through `present` and refuses every method, and `createPresentation` is
// the same frames drawn for a log, with none of the sequences in them.

const readline = require('node:readline');

/** The glyphs the frames are drawn from. `quiet` is the one Clack has no name for: not measured. */
const SYMBOL = Object.freeze({
    open: '┌',
    guide: '│',
    close: '└',
    rule: '─',
    waiting: '◆',
    submitted: '◇',
    refused: '▲',
    cancelled: '■',
    quiet: '○',
    chosen: '●',
    unchosen: '○',
    boxTopRight: '╮',
    boxBottomRight: '╯',
    boxLeft: '├',
    mask: '▪',
});

/** The spinner's cycle, in the order Clack turns it. */
const CYCLING = Object.freeze(['◒', '◐', '◓', '◑']);

/** The escape sequences this file writes, and the only ones: cursor, erase, and the styles below. */
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const ERASE_DOWN = '\u001b[0J';

const sgr = (set, unset) => (text) => `\u001b[${set}m${text}\u001b[${unset}m`;

/** What the frames are painted with — Clack's own palette, by SGR code. */
const PAINT = Object.freeze({
    cyan: sgr(36, 39),
    green: sgr(32, 39),
    gray: sgr(90, 39),
    yellow: sgr(33, 39),
    red: sgr(31, 39),
    magenta: sgr(35, 39),
    dim: sgr(2, 22),
    inverse: sgr(7, 27),
});

/** The same palette with none of it: the frames a log gets, character for character. */
const PLAIN = Object.freeze(Object.fromEntries(Object.keys(PAINT).map((style) => [style, (text) => text])));

/** A refusal of the one thing this file will not do: ask somebody who is not there. */
class NoTerminal extends Error {
    constructor() {
        super('There is no terminal here to ask on. Answer with flags, or write them into a file'
            + ' and pass --answers <file>.');
        this.name = 'NoTerminal';
    }
}

// ── The frames, which are pure ──────────────────────────────────────────────────

/** How wide a line is on a screen: whatever draws it — an escape sequence — occupies nothing. */
const visibleWidth = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, '').length;

/**
 * How many rows a frame takes on a screen: one for each line, and one more for every time a line
 * runs past the last column and the terminal wraps it onto the next. A line ending exactly at the
 * last column has not wrapped yet — the terminal wraps when the next character arrives — so a
 * screen's worth of text is one row, not two.
 *
 * Counting lines instead of rows is what walked the prompt down the screen: the `◆  <question>` line
 * of an ordinary wizard question is wider than eighty columns, so it draws two rows, and a redraw
 * that moved up by `lines - 1` began a row lower every time.
 */
const rows = (lines, columns) => lines.reduce(
    (total, line) => total + Math.max(1, Math.ceil(visibleWidth(line) / Math.max(columns, 1))),
    0,
);

/** One line of the box, as wide as it needs to be: this is where padding is decided, not the eye. */
const pad = (line, width) => line + ' '.repeat(Math.max(0, width - visibleWidth(line)));

/**
 * Text broken to fit a width: a box wider than the screen is a box nobody reads. A line's own
 * indentation is kept, so a value wrapped under a label stays visibly under it — and a word longer
 * than the room, a path usually, is cut rather than allowed to run past the box it is in.
 */
function wrap(text, width) {
    const lines = [];
    for (const paragraph of String(text).split('\n')) {
        const indent = /^\s*/.exec(paragraph)[0];
        const room = Math.max(width - indent.length, 4);
        let line = '';
        const flush = () => { lines.push(indent + line); line = ''; };
        for (const word of paragraph.slice(indent.length).split(' ')) {
            if (line && line.length + 1 + word.length > room) flush();
            let rest = word;
            while (rest.length > room) {
                if (line) flush();
                lines.push(indent + rest.slice(0, room));
                rest = rest.slice(room);
            }
            line = line ? `${line} ${rest}` : rest;
        }
        flush();
    }
    return lines;
}

/** `┌  <title>` — the one line an interaction opens with. */
const opening = (title, paint = PAINT) => `${paint.gray(SYMBOL.open)}  ${title}`;

/** `│` and `└  <message>` — the two lines an interaction closes with. */
const closing = (message, paint = PAINT) => [paint.gray(SYMBOL.guide), `${paint.gray(SYMBOL.close)}  ${message}`];

/** How much room a box's body has inside it: the frame takes six columns, the rest is air. */
const roomFor = (columns) => Math.max(columns - 8, 24);

/**
 * The boxed note: `◇  <title> ───╮`, the body between guides, and `├───╯` under it. It is what
 * `note` draws in Clack, and it is what the summary this wizard ends with is made of.
 */
function boxed(body, title, paint = PAINT, columns = 80) {
    const lines = ['', ...wrap(body, roomFor(columns)), ''];
    const widest = lines.reduce((width, line) => Math.max(width, visibleWidth(line)), visibleWidth(title));
    const width = widest + 2;
    const top = `${paint.green(SYMBOL.submitted)}  ${title} ${paint.gray(`${SYMBOL.rule.repeat(Math.max(width - visibleWidth(title) - 1, 1))}${SYMBOL.boxTopRight}`)}`;
    return [
        paint.gray(SYMBOL.guide),
        top,
        ...lines.map((line) => `${paint.gray(SYMBOL.guide)}  ${pad(line, width)}${paint.gray(SYMBOL.guide)}`),
        paint.gray(`${SYMBOL.boxLeft}${SYMBOL.rule.repeat(width + 2)}${SYMBOL.boxBottomRight}`),
    ];
}

/** The guide line and the `◆  <message>` above whatever a prompt is about to draw. */
const asked = (message, paint, mark = SYMBOL.waiting, ink = 'cyan') => [
    paint.gray(SYMBOL.guide),
    `${paint[ink](mark)}  ${message}`,
];

/**
 * A field, as it is drawn under its question: what has been typed with the character the caret is
 * on turned about, or the placeholder when nothing has been typed — the first character boxed, the
 * rest dim, which is how Clack shows a value that is offered rather than given.
 *
 * A `mask` hides what was typed and keeps only its length, which is what a password deserves.
 */
function field(state, placeholder, paint, mask = '') {
    if (!state.value) {
        if (mask) return paint.inverse(mask);
        return placeholder ? paint.inverse(placeholder[0]) + paint.dim(placeholder.slice(1)) : paint.inverse(' ');
    }
    const shown = mask ? mask.repeat(state.value.length) : state.value;
    return shown.slice(0, state.caret) + paint.inverse(shown[state.caret] || mask || ' ') + shown.slice(state.caret + 1);
}

/** A text question: waiting, refused, or answered. A hidden one shows its length and nothing else. */
function textFrame(state, { message, placeholder = '', paint = PAINT, hidden = false } = {}) {
    const mask = hidden ? SYMBOL.mask : '';
    const typed = mask ? mask.repeat(state.value.length) : state.value;
    if (state.settled === 'submitted') {
        return [...asked(message, paint, SYMBOL.submitted, 'green'), `${paint.gray(SYMBOL.guide)}  ${paint.dim(typed)}`];
    }
    if (state.settled === 'cancelled') {
        return [...asked(message, paint, SYMBOL.cancelled, 'red'), `${paint.gray(SYMBOL.guide)}  ${paint.dim(typed)}`];
    }
    if (state.problem) {
        return [
            ...asked(message, paint, SYMBOL.refused, 'yellow'),
            `${paint.yellow(SYMBOL.guide)}  ${typed}`,
            `${paint.yellow(SYMBOL.close)}  ${paint.yellow(state.problem)}`,
        ];
    }
    return [...asked(message, paint), `${paint.cyan(SYMBOL.guide)}  ${field(state, placeholder, paint, mask)}`, paint.cyan(SYMBOL.close)];
}

/** A menu: the options, the pointer on one of them, and the keys that move it underneath. */
function selectFrame(state, { message, options, paint = PAINT } = {}) {
    const at = options[state.cursor];
    if (state.settled === 'submitted') {
        return [...asked(message, paint, SYMBOL.submitted, 'green'), `${paint.gray(SYMBOL.guide)}  ${paint.dim(at.label ?? String(at.value))}`];
    }
    if (state.settled === 'cancelled') {
        return [...asked(message, paint, SYMBOL.cancelled, 'red'), `${paint.gray(SYMBOL.guide)}  ${paint.dim(at.label ?? String(at.value))}`];
    }
    const rows = options.map((option, index) => {
        const chosen = index === state.cursor;
        const label = option.label ?? String(option.value);
        const pointer = chosen ? paint.green(SYMBOL.chosen) : paint.dim(SYMBOL.unchosen);
        return `${paint.cyan(SYMBOL.guide)}  ${pointer} ${chosen ? label : paint.dim(label)}`
            + `${option.hint ? ` ${paint.dim(`(${option.hint})`)}` : ''}`;
    });
    return [
        ...asked(message, paint),
        ...rows,
        `${paint.cyan(SYMBOL.guide)}  ${paint.dim('↑/↓')} to navigate • ${paint.dim('Enter:')} confirm`,
        paint.cyan(SYMBOL.close),
    ];
}

/** A yes-or-no question, both answers on one line with the chosen one pointed at. */
function confirmFrame(state, { message, yes = 'Yes', no = 'No', paint = PAINT } = {}) {
    const answered = state.value ? yes : no;
    if (state.settled === 'submitted') {
        return [...asked(message, paint, SYMBOL.submitted, 'green'), `${paint.gray(SYMBOL.guide)}  ${paint.dim(answered)}`];
    }
    if (state.settled === 'cancelled') {
        return [...asked(message, paint, SYMBOL.cancelled, 'red'), `${paint.gray(SYMBOL.guide)}  ${paint.dim(answered)}`];
    }
    const pair = (label, chosen) => (chosen ? `${paint.green(SYMBOL.chosen)} ${label}` : `${paint.dim(SYMBOL.unchosen)} ${paint.dim(label)}`);
    return [
        ...asked(message, paint),
        `${paint.cyan(SYMBOL.guide)}  ${pair(yes, state.value)} ${paint.dim('/')} ${pair(no, !state.value)}`,
        paint.cyan(SYMBOL.close),
    ];
}

// ── The keys, which are pure ────────────────────────────────────────────────────

/**
 * One keypress, in the one vocabulary the prompts below speak: a name for the keys that mean
 * something to them, and the character itself when it is something a person typed. `Ctrl-C` and a
 * bare `Escape` are the same word — a way out — which is Clack's bargain as well.
 */
function stroke(char, key = {}) {
    const name = key.name || '';
    const held = key.ctrl === true || key.meta === true;
    if (name === 'return' || name === 'enter') return { name: 'enter', char: '' };
    if (name === 'escape' || (held && name === 'c')) return { name: 'cancel', char: '' };
    if (name === 'backspace') return { name: 'backspace', char: '' };
    if (name === 'delete') return { name: 'delete', char: '' };
    if (name === 'tab') return { name: 'tab', char: '' };
    if (['up', 'down', 'left', 'right', 'home', 'end'].includes(name)) return { name, char: '' };
    if (held && name === 'a') return { name: 'home', char: '' };
    if (held && name === 'e') return { name: 'end', char: '' };
    if (held && name === 'u') return { name: 'clear', char: '' };
    if (held && name === 'w') return { name: 'erase-word', char: '' };
    if (held) return { name: 'ignored', char: '' };
    return char && char >= ' ' ? { name: 'char', char } : { name: 'ignored', char: '' };
}

/** Whether a keypress is the pointer walking round a menu, at either end. */
const walked = (pressed) => (pressed.name === 'up' || pressed.char === 'k' ? -1
    : (pressed.name === 'down' || pressed.char === 'j' ? 1 : 0));

/** Where a menu is: which option the pointer is on, and whether it has settled. */
const settle = (state, how) => ({ ...state, settled: how });

/** A menu, after one keypress. The pointer wraps, because a list of three has nowhere to stop. */
function selectStep(state, options, pressed) {
    if (state.settled) return state;
    const count = options.length;
    const move = walked(pressed);
    if (move) return { ...state, cursor: (state.cursor + move + count) % count };
    if (pressed.name === 'enter') return settle(state, 'submitted');
    if (pressed.name === 'cancel') return settle(state, 'cancelled');
    return state;
}

/** A field, after one keypress: the line editing it takes, and the validator asked on Enter. */
function textStep({ value, caret, problem }, pressed, validate, fallback = '') {
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const edit = (next, at) => ({ value: next, caret: at, problem: '', settled: null });
    switch (pressed.name) {
        case 'cancel': return { value, caret, problem, settled: 'cancelled' };
        case 'enter': {
            const refused = validate ? validate(value) : null;
            if (refused) return { value, caret, problem: String(refused), settled: null };
            // An empty line takes the default, and the field settles on *that*: what the frame
            // shows after Enter is what the answer is, not the nothing that was typed.
            const settled = value || fallback;
            return { value: settled, caret: settled.length, problem: '', settled: 'submitted' };
        }
        case 'backspace': return edit(value.slice(0, caret - 1) + after, Math.max(0, caret - 1));
        case 'delete': return edit(before + value.slice(caret + 1), caret);
        case 'left': return { value, caret: Math.max(0, caret - 1), problem: '', settled: null };
        case 'right': return { value, caret: Math.min(value.length, caret + 1), problem: '', settled: null };
        case 'home': return { value, caret: 0, problem: '', settled: null };
        case 'end': return { value, caret: value.length, problem: '', settled: null };
        case 'clear': return edit(after, 0);
        case 'erase-word': {
            const kept = value.slice(0, caret).replace(/\s*\S*$/, '');
            return edit(kept + after, kept.length);
        }
        case 'char': return edit(before + pressed.char + after, caret + pressed.char.length);
        default: return { value, caret, problem, settled: null };
    }
}

/** A yes-or-no question, after one keypress: `y` and `n` answer it outright, as they do in Clack. */
function confirmStep(state, pressed) {
    if (state.settled) return state;
    if (pressed.name === 'enter') return settle(state, 'submitted');
    if (pressed.name === 'cancel') return settle(state, 'cancelled');
    if (['left', 'right', 'tab'].includes(pressed.name) || pressed.char === ' ') return { ...state, value: !state.value };
    if (pressed.char === 'y' || pressed.char === 'Y') return { ...state, value: true, settled: 'submitted' };
    if (pressed.char === 'n' || pressed.char === 'N') return { ...state, value: false, settled: 'submitted' };
    return state;
}

// ── The streams ─────────────────────────────────────────────────────────────────

/**
 * One question at a terminal: draw what the question's state says to draw, hand each keypress to
 * the question, and settle when it says it has. `draw` and `step` are pure, so every key and every
 * frame below is decided somewhere a test can reach, and here there is nothing but plumbing.
 *
 * The cursor is deliberately left where the last frame ended — the line under it is the next
 * question's — so a question that has not settled redraws over itself instead of scrolling.
 */
function converse({ input, output, draw, step, state, columns }) {
    return new Promise((resolve) => {
        readline.emitKeypressEvents(input);
        const wasRaw = Boolean(input.isRaw);
        if (input.isTTY) input.setRawMode(true);
        input.resume();
        output.write(HIDE_CURSOR);

        let drawn = null;
        let current = state;

        /**
         * A frame over the one before it, which is measured in rows and not in lines: a line the
         * terminal wrapped draws on two of them, and moving up by the number of lines leaves the
         * frame that many rows lower each time it is redrawn — the rows it walks past are above the
         * cursor `ERASE_DOWN` clears below, so nothing ever takes them back.
         *
         * The width is read here rather than kept from the prompter's making: a terminal rewraps its
         * screen when it is resized, so the frame already drawn is measured at the width the next
         * one will be drawn at.
         */
        const render = (next) => {
            current = next;
            const lines = draw(next);
            if (drawn) {
                const above = rows(drawn, columns()) - 1;
                if (above > 0) output.write(`\u001b[${above}A`);
                output.write(`\r${ERASE_DOWN}`);
            }
            // From column zero, always: the cursor may have been left anywhere — hiding it does not
            // move it — and a guide line that starts mid-row is a frame that does not line up.
            output.write(`\r${lines.join('\r\n')}`);
            drawn = lines;
        };
        render(current);

        const onKey = (char, key) => {
            const next = step(current, stroke(char, key));
            if (next === current) return;
            render(next);
            if (!next.settled) return;
            input.removeListener('keypress', onKey);
            if (input.isTTY) input.setRawMode(wasRaw);
            input.pause();
            output.write(`\r\n${SHOW_CURSOR}\n`);
            // Ctrl-C is a way out, and it leaves the terminal as it found it — the same bargain
            // `src/admin.js` strikes for the console's password.
            if (next.settled === 'cancelled') process.exit(130);
            resolve(current);
        };
        input.on('keypress', onKey);
    });
}

/** The frames written one line at a time, which is all `intro`, `outro` and `note` ever do. */
const speaking = (write, paint, columns) => ({
    columns,
    width: roomFor(columns),
    intro: (title) => write(opening(title, paint)),
    outro: (message) => { closing(message, paint).forEach(write); write(''); },
    note: (body, title) => boxed(body, title, paint, columns).forEach(write),
});

/** Every method of a prompter that has no terminal: the refusal, and nothing drawn. */
const refusing = () => {
    const no = () => { throw new NoTerminal(); };
    return {
        intro: no, outro: no, note: no, select: no, text: no, confirm: no, spinner: no,
        close: () => {},
    };
};

/** The same frames with none of the escape sequences in them, for a log or a page. */
const createPresentation = ({ write, columns = 80 } = {}) => speaking(write, PLAIN, columns);

/**
 * A terminal, as everything this wizard needs to say something to one.
 *
 * `present` is the whole of whether it can be used; with no terminal every method refuses rather
 * than drawing a question nobody asked. `input` and `output` are options so that the key handling
 * can be driven by a scripted stream, which is how the tests reach it.
 */
function createPrompter({ input = process.stdin, output = process.stdout, paint = PAINT, columns = null, interval = 80 } = {}) {
    if (!(input.isTTY === true && output.isTTY === true)) return { present: false, ...refusing() };

    // A terminal that has not been told how wide it is reports zero columns — which is what a
    // pseudo-terminal without a window size looks like — and a box drawn to no width is not a box.
    // Read again for every frame, because a resize between two of them moves the wrap points.
    const columnsNow = () => (columns ?? (output.columns > 0 ? output.columns : 80));
    const width = columnsNow();
    const say = (line) => output.write(`${line}\n`);
    const ask = (draw, step, state) => converse({ input, output, draw, step, state, columns: columnsNow });

    return {
        present: true,
        ...speaking(say, paint, width),

        /** One option out of many, chosen with the arrow keys. */
        select: ({ message, options, initial }) => ask(
            (state) => selectFrame(state, { message, options, paint }),
            (state, pressed) => selectStep(state, options, pressed),
            { cursor: Math.max(0, options.findIndex((option) => option.value === initial)), settled: null },
        ).then((state) => options[state.cursor].value),

        /** One line of text, offered a default that Enter takes — and masked, if it is a secret. */
        text: ({ message, placeholder = '', defaultValue = '', validate, hidden = false }) => ask(
            (state) => textFrame(state, { message, placeholder, hidden, paint }),
            (state, pressed) => textStep(state, pressed, validate, defaultValue),
            { value: '', caret: 0, problem: '', settled: null },
        ).then((state) => state.value),

        /** One answer to one question. */
        confirm: ({ message, initialValue = true }) => ask(
            (state) => confirmFrame(state, { message, paint }),
            confirmStep,
            { value: initialValue, settled: null },
        ).then((state) => state.value),

        /** Work that takes long enough to have to say it is still going. */
        spinner: () => {
            let running = false;
            let drawn = 0;
            let turn = 0;
            let said = '';
            let timer = null;
            // One line, but as many rows as the terminal wraps it onto: a spinner message longer
            // than the screen is drawn on two, and erased as one it leaves the first of them behind
            // for the next turn to land under — a new row of them for every tick.
            const erase = () => {
                if (!drawn) return;
                if (drawn > 1) output.write(`\u001b[${drawn - 1}A`);
                output.write(`\r${ERASE_DOWN}`);
                drawn = 0;
            };
            const draw = () => {
                erase();
                const line = `${paint.magenta(CYCLING[turn])}  ${said}`;
                output.write(line);
                drawn = rows([line], columnsNow());
            };
            return {
                start: (message) => {
                    said = String(message).replace(/\.+$/, '');
                    output.write(`${paint.gray(SYMBOL.guide)}\n`);
                    running = true;
                    timer = setInterval(() => { turn = (turn + 1) % CYCLING.length; draw(); }, interval);
                    timer.unref();
                    draw();
                },
                message: (text) => { said = String(text).replace(/\.+$/, ''); if (running) draw(); },
                stop: (text) => {
                    if (!running) return;
                    running = false;
                    clearInterval(timer);
                    erase();
                    output.write(`${paint.green(SYMBOL.submitted)}  ${text ?? said}\n`);
                },
            };
        },

        /** The cursor back, for a run that ended without its last prompt closing it. */
        close: () => output.write(SHOW_CURSOR),
    };
}

module.exports = {
    createPrompter,
    createPresentation,
    NoTerminal,
    SYMBOL,
    PAINT,
    PLAIN,
    frames: { opening, closing, boxed, textFrame, selectFrame, confirmFrame, wrap, rows, visibleWidth },
    stroke,
    steps: { selectStep, textStep, confirmStep },
};
