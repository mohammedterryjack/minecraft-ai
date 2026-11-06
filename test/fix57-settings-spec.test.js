/**
 * fix57: settings_spec.json must JSON.parse the way mindserver.js loads it.
 *
 * Root cause: PR #44 removed check_timeout_interval_ms / event_loop_stall_poll_interval_ms /
 * world_scan_stall_warn_distance from settings_spec.json but left a trailing comma before the
 * final `}`, so mindserver.js:20 JSON.parse threw at startup and icefox crash-looped.
 * No prior test loaded this file, so npm test stayed green.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import settings from '../settings.js';
import { wrapBotForApiTiming } from '../src/utils/bot_api_timing.js';

const REMOVED_KEYS = [
    'check_timeout_interval_ms',
    'event_loop_stall_poll_interval_ms',
    'world_scan_stall_warn_distance',
];

/** Same path resolution mindserver.js uses (dirname of mindserver.js + public/settings_spec.json). */
function loadSettingsSpecLikeMindserver() {
    const mindserverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/mindcraft');
    return JSON.parse(readFileSync(path.join(mindserverDir, 'public/settings_spec.json'), 'utf8'));
}

function runtimeType(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

describe('fix57: settings_spec.json (mindserver load path)', () => {
    it('JSON.parse succeeds (no trailing comma)', () => {
        const settings_spec = loadSettingsSpecLikeMindserver();
        assert.equal(typeof settings_spec, 'object');
        assert.ok(settings_spec !== null);
        assert.ok('spawn_timeout' in settings_spec);
    });

    it('every settings.js key that appears in the spec has a matching runtime type', () => {
        const settings_spec = loadSettingsSpecLikeMindserver();
        const mismatches = [];
        for (const key of Object.keys(settings)) {
            if (!(key in settings_spec)) continue;
            const want = settings_spec[key].type;
            const got = runtimeType(settings[key]);
            // Spec type "object" allows null (task/profile defaults); otherwise types must match.
            if (want === 'object' && (got === 'object' || got === 'null')) continue;
            if (got !== want) {
                mismatches.push(`${key}: settings.js is ${got}, spec type is ${want}`);
            }
        }
        assert.deepStrictEqual(mismatches, []);
    });

    it('removed stall-setting keys appear in neither settings.js nor the spec', () => {
        const settings_spec = loadSettingsSpecLikeMindserver();
        for (const key of REMOVED_KEYS) {
            assert.ok(!(key in settings), `settings.js must not define ${key}`);
            assert.ok(!(key in settings_spec), `settings_spec.json must not define ${key}`);
        }
    });
});

describe('fix57: bot_api_timing logs only over learned stall threshold', () => {
    it('does not log when threshold is not learned', () => {
        const bot = {
            blockAt() {
                return null;
            },
        };
        const logs = [];
        const orig = console.log;
        console.log = (...a) => {
            logs.push(a.map(String).join(' '));
        };
        try {
            const timed = wrapBotForApiTiming(bot);
            timed.blockAt();
        } finally {
            console.log = orig;
        }
        assert.deepStrictEqual(
            logs.filter((l) => l.includes('[bot-api]')),
            []
        );
    });

    it('does not log when duration is at or under the learned threshold', () => {
        const bot = {
            __eventLoopStallThresholdMs: 50,
            blockAt() {
                return null;
            },
        };
        const logs = [];
        const orig = console.log;
        console.log = (...a) => {
            logs.push(a.map(String).join(' '));
        };
        try {
            const timed = wrapBotForApiTiming(bot);
            timed.blockAt();
        } finally {
            console.log = orig;
        }
        assert.deepStrictEqual(
            logs.filter((l) => l.includes('[bot-api]')),
            []
        );
    });

    it('logs when duration exceeds the learned threshold', async () => {
        const bot = {
            __eventLoopStallThresholdMs: 5,
            async slow() {
                await new Promise((r) => setTimeout(r, 20));
                return 1;
            },
        };
        const logs = [];
        const orig = console.log;
        console.log = (...a) => {
            logs.push(a.map(String).join(' '));
        };
        try {
            const timed = wrapBotForApiTiming(bot);
            await timed.slow();
        } finally {
            console.log = orig;
        }
        const apiLogs = logs.filter((l) => l.includes('[bot-api]'));
        assert.equal(apiLogs.length, 1);
        assert.ok(apiLogs[0].includes('slow'), apiLogs[0]);
        assert.ok(/slow \d+ms/.test(apiLogs[0]), apiLogs[0]);
    });

    it('throws if __eventLoopStallThresholdMs is set but invalid', () => {
        const bot = {
            __eventLoopStallThresholdMs: -1,
            blockAt() {
                return null;
            },
        };
        const timed = wrapBotForApiTiming(bot);
        assert.throws(() => timed.blockAt(), /positive finite number/);
    });
});
