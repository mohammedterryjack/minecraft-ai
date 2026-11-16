/**
 * fix123: bot.blockAt requires a Vec3 — mineflayer's blockAt passes the point straight to
 * prismarine-world, whose WorldSync.getBlock calls pos.floored()
 * (node_modules/prismarine-world/src/worldsync.js:101-102). Code-model output passes plain
 * {x,y,z} object literals to it (live: repaired craftRecipe calling bot.blockAt({x,y,z})
 * crashed 128 times with "pos.floored is not a function"). Every generated-code bot call
 * already passes through the timedBotApi proxy, and fix97 established argument enforcement
 * there (assertFindBlocksOptions). Normalize position-like first args at that same boundary
 * so the class cannot crash the process again; anything else passes through unchanged.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Vec3 } from 'vec3';
import { wrapBotForApiTiming, setBotApiDurationStore } from '../src/utils/bot_api_timing.js';

function mkWrapped(record) {
    setBotApiDurationStore({});
    const bot = {
        blockAt(p) { record.p = p; return null; },
    };
    return wrapBotForApiTiming(bot);
}

describe('fix123: blockAt accepts position-like args', () => {
    it('a plain {x,y,z} is coerced to a Vec3 before the call', () => {
        const record = {};
        const bot = mkWrapped(record);
        bot.blockAt({ x: -176.4, y: 41.2, z: 104.8 });
        assert.ok(typeof record.p.floored === 'function', 'blockAt received a Vec3 (has floored())');
        assert.ok(record.p instanceof Vec3);
        const f = record.p.floored();
        assert.strictEqual(f.x, -177);
        assert.strictEqual(f.y, 41);
        assert.strictEqual(f.z, 104);
    });

    it('a real Vec3 passes through untouched (same identity)', () => {
        const record = {};
        const bot = mkWrapped(record);
        const v = new Vec3(1.5, 2.5, 3.5);
        bot.blockAt(v);
        assert.strictEqual(record.p, v);
    });

    it('an object without finite x/y/z passes through (the call fails as before)', () => {
        const record = {};
        const bot = mkWrapped(record);
        const junk = { a: 1 };
        bot.blockAt(junk);
        assert.strictEqual(record.p, junk);
    });
});
