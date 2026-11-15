/**
 * fix118 (live icefox2000, 15 Nov 2026, 17:5x GMT): vanilla 26.x command feedback
 * ("Set minecraft:overworld to time marker minecraft:night]", "Gave 1 [Cherry Leaves]
 * to S4ku24_Moonglich]") arrives attributed to the op player and passed the 1.20-era
 * ignore_messages prefixes in agent.js respondFunc — the bot answered a time marker
 * with !stay(600) twice and answered /give feedback like chat, burning conversation
 * turns and GPU queue while real players waited.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';

const src = readFileSync('src/agent/agent.js', 'utf8');
const block = src.slice(src.indexOf('const ignore_messages = ['), src.indexOf('];', src.indexOf('const ignore_messages = [')));
const entries = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

// real 26.x command-feedback lines captured from logs/mindcraft.log 17:5x
const system_feedback = [
    'Set minecraft:overworld to time marker minecraft:night]',
    'Gave 1 [Cherry Leaves] to S4ku24_Moonglich]',
    'Set the time to 6000',           // legacy strings keep working
    'Teleported S4ku24_Moonglich to 1, 2, 3',
];
// real player messages captured the same hour
const player_messages = [
    'yo what you up to?',
    '...guys?',
    'what happened?',
    'hey s4ku24 got torches',
];

describe('fix118: 26.x command feedback is filtered, player chat is not', () => {
    it('the ignore list exists and is non-trivial', () => {
        assert.ok(entries.length >= 9);
    });
    for (const msg of system_feedback) {
        it(`ignores "${msg.slice(0, 50)}"`, () => {
            assert.ok(entries.some((m) => msg.startsWith(m)),
                `"${msg}" must match a startsWith entry in ignore_messages`);
        });
    }
    for (const msg of player_messages) {
        it(`still answers "${msg.slice(0, 50)}"`, () => {
            assert.ok(!entries.some((m) => msg.startsWith(m)),
                `"${msg}" must NOT be swallowed by ignore_messages`);
        });
    }
});
