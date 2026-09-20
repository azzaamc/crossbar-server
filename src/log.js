'use strict';

// Structured, single-line logging. Redaction is by construction: callers pass only
// the fields they mean to publish, and nothing here walks an object for secrets.
//
// The rule this file exists to enforce: a value that authenticates somebody is
// never a log field. No identity headers, no tickets, no API secrets, no SDP, no
// ICE candidates, no push endpoints.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger({ level = 'info', stream = process.stdout } = {}) {
    const threshold = LEVELS[level] ?? LEVELS.info;

    function write(levelName, event, fields) {
        if (LEVELS[levelName] < threshold) return;
        const record = { ts: new Date().toISOString(), level: levelName, event };
        if (fields && typeof fields === 'object') {
            for (const [key, value] of Object.entries(fields)) {
                if (value === undefined) continue;
                record[key] = value;
            }
        }
        let line;
        try {
            line = JSON.stringify(record);
        } catch {
            line = JSON.stringify({ ts: record.ts, level: levelName, event, note: 'unserializable fields' });
        }
        stream.write(`${line}\n`);
    }

    return {
        level,
        debug: (event, fields) => write('debug', event, fields),
        info: (event, fields) => write('info', event, fields),
        warn: (event, fields) => write('warn', event, fields),
        error: (event, fields) => write('error', event, fields),
    };
}

module.exports = { createLogger };
