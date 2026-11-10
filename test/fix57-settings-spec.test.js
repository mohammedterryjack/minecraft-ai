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
import { wrapBotForApiTiming, setBotApiDurationStore, _clearBotApiDurationStoreForTest } from '../src/utils/bot_api_timing.js';

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

describe('fix57: bot_api_timing logs only past the recorded durations of that method', () => {
    it('throws when no duration store is attached, and a non-object store is rejected', () => {
        assert.throws(() => setBotApiDurationStore(null), /duration store must be an object/);
        assert.throws(() => setBotApiDurationStore([]), /duration store must be an object/);
        _clearBotApiDurationStoreForTest();
        const bot = { blockAt() { return null; } };
        const timed = wrapBotForApiTiming(bot);
        assert.throws(() => timed.blockAt(), /duration store is not attached/);
    });

    it('the first call is recorded and does not log, and a later call within that maximum does not log', () => {
        const store = {};
        setBotApiDurationStore(store);
        const realNow = Date.now;
        let now = 1_000;
        Date.now = () => now;
        const logs = [];
        const orig = console.log;
        console.log = (...a) => logs.push(a.map(String).join(' '));
        const bot = { blockAt() { now += 4; return null; } };
        try {
            const timed = wrapBotForApiTiming(bot);
            timed.blockAt();
            timed.blockAt();
        } finally {
            Date.now = realNow;
            console.log = orig;
        }
        assert.deepStrictEqual(logs.filter((l) => l.includes('[bot-api]')), []);
        assert.strictEqual(store.blockAt.n, 2);
        assert.strictEqual(store.blockAt.max, 4);
    });

    it('a call longer than every recorded call of that method logs the recorded maximum', () => {
        const store = {};
        setBotApiDurationStore(store);
        const realNow = Date.now;
        let now = 1_000;
        Date.now = () => now;
        const logs = [];
        const orig = console.log;
        console.log = (...a) => logs.push(a.map(String).join(' '));
        const bot = { blockAt() { now += 4; return null; } };
        try {
            const timed = wrapBotForApiTiming(bot);
            timed.blockAt();
            bot.blockAt = () => { now += 9; return null; };
            timed.blockAt();
        } finally {
            Date.now = realNow;
            console.log = orig;
        }
        const apiLogs = logs.filter((l) => l.includes('[bot-api]'));
        assert.equal(apiLogs.length, 1);
        assert.match(apiLogs[0], /blockAt 9ms exceeds the longest recorded blockAt call \(4ms across 1 call/);
        assert.doesNotMatch(apiLogs[0], /keep-alive|30000/);
    });
});
