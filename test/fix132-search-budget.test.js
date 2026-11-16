/**
 * fix132 (live icefox2000, 16 Nov 2026 18:36–18:55 GMT): the hunger serve hung 20 minutes at
 * 80% CPU with RSS 1.4 GB. Stack sample: timer-driven async generator resolving in a loop —
 * pathToBlock stepping an A* that never ended. openSearch passes timeout:
 * Number.POSITIVE_INFINITY on the theory that "the loaded columns bound the open set"
 * (world.js). Measured twice that the theory fails: fix110 logged a probe "still 'partial' at
 * 4400 s with 1.4M nodes visited and the open heap growing", and today's search reproduced it
 * (RSS +1.4 GB, no status). mineflayer-pathfinder itself ships thinkTimeout (index.js:40,
 * default 5000 ms) for exactly this — the same total budget every normal goto runs under
 * (mindcraft's own pathfind_timeout is 4000 ms). A search that exceeds the think budget the
 * whole system already accepts fails LOUDLY; it does not eat the machine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import { pathToBlock } from '../src/agent/library/world.js';

const registry = Registry('1.20.4');

function mkBot(opts = { status: 'timeout', captured: {} }) {
    if (!opts.captured) opts.captured = {};
    if (!opts.status) opts.status = 'timeout';
    return {
        registry,
        game: { gameMode: 'survival' },
        entity: { position: new Vec3(0, 33, 0), eyeHeight: 1.62 },
        world: {},
        blockAt: () => ({ name: 'stone', shapes: [{}] }),
        async waitForTicks() {},
        pathfinder: {
            thinkTimeout: 5000,
            tickTimeout: 40,
            movements: {},
            * getPathFromTo(movements, start, goal, options) {
                opts.captured.options = options;
                yield { result: { status: 'partial' } };
                yield { result: { status: opts.status } };
            },
        },
    };
}

describe('fix132 pathToBlock search is bounded by the pathfinder think budget', () => {
    it('passes a finite total timeout (bot.pathfinder.thinkTimeout), not +Infinity', async () => {
        const captured = {};
        const bot = mkBot({ status: 'noPath', captured });
        bot.pathfinder.getPathFromTo = function* (m, s, g, options) {
            captured.options = options;
            yield { result: { status: 'noPath', cost: 5 } };
        };
        const r = await pathToBlock(bot, new Vec3(10, 33, 0));
        assert.strictEqual(r.status, 'noPath');
        assert.ok(Number.isFinite(captured.options.timeout), `timeout was ${captured.options.timeout}`);
        assert.strictEqual(captured.options.timeout, 5000);
    });

    it('a thinkTimeout result fails loudly instead of hanging', async () => {
        const bot = mkBot({});
        await assert.rejects(() => pathToBlock(bot, new Vec3(10, 33, 0)), /thinkTimeout/);
    });
});
