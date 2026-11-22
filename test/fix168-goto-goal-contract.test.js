/**
 * fix168 (live icefox2000 22 Nov 2026 ~09:40Z): bot in the shaft at y=40, food 15 health 9 —
 * every travelTo logged "Path not found, but attempting to navigate anyway using destructive
 * movements.", then `goToGoal -> true` while goToPosition measured 5-10 blocks ("unable to
 * reach ...; still 5 blocks away"), forever. Root cause is in mineflayer-pathfinder: goto()
 * resolves on ANY 'path_update' with an empty path (lib/goto.js:21-24 — length check before
 * the status checks), and astar's 'noPath'/'timeout' results carry reconstructPath(bestNode),
 * which is [] when bestNode is still the start node (lib/astar.js:24-31): zero nodes expanded
 * (buried / sealed by water) reads as "goal reached" without moving. goToGoal now verifies the
 * goal's own isEnd at the floored position (or one above, the library's arrival rule at
 * index.js:611) before claiming success.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import pf from 'mineflayer-pathfinder';
import { goToGoal, goToPosition, goToBed } from '../src/agent/library/skills.js';
import { setMovementStore } from '../src/utils/movement_model.js';

const registry = Registry('1.20.4');

// mkBot: dry land everywhere (no swim legs), goToGoal's pre-check reports a usable path,
// and goto() resolves immediately — like the library does for an empty-path path_update —
// either without moving the bot (falselyArrives) or after putting it at the goal.
function mkBot({ move }) {
    const bot = Object.assign(new EventEmitter(), {
        registry,
        output: '',
        interrupt_code: false,
        game: { gameMode: 'survival' },
        entity: { position: new Vec3(-152.5, 40, 113.5), isInWater: false },
        modes: { isOn: () => false },
        inventory: { items: () => [] },
        setControlState() {},
        async lookAt() {},
        blockAt() { return { name: 'air', liquid: false }; },
        async waitForTicks(n) { for (let t = 0; t < n; t++) await Promise.resolve(); },
        pathfinder: {
            setMovements() {},
            stop() {},
            isMoving() { return false; },
            isMining() { return false; },
            isBuilding() { return false; },
            async getPathTo() { return { status: 'success' }; },
            async goto() { move(bot); },
        },
    });
    return bot;
}

describe('fix168: goToGoal verifies the goal before returning true', () => {
    it('rejects a goto() that resolved without arriving (empty-path path_update at the start node)', async () => {
        setMovementStore({ swim: { n: 5, max: 200, cuts: 0 }, walk: { n: 5, max: 5000, cuts: 0 } });
        const bot = mkBot({ move: () => { /* bot never moved: astar died at the start */ } });
        const goal = new pf.goals.GoalNear(-152, 40, 105, 3);   // 8 blocks away
        const ok = await goToGoal(bot, goal);
        assert.strictEqual(ok, false, `output: ${bot.output}`);
        assert.match(bot.output, /the goal is not satisfied from .*\(search died at the start/);
    });
    it('accepts a goto() that actually arrived', async () => {
        setMovementStore({ swim: { n: 5, max: 200, cuts: 0 }, walk: { n: 5, max: 5000, cuts: 0 } });
        const bot = mkBot({ move: (b) => b.entity.position.set(-152.2, 40, 106.4) });
        const goal = new pf.goals.GoalNear(-152, 40, 105, 3);
        const ok = await goToGoal(bot, goal);
        assert.strictEqual(ok, true, `output: ${bot.output}`);
    });
    it('goToPosition now fails on the first try instead of reporting success 5 blocks short', async () => {
        setMovementStore({ swim: { n: 5, max: 200, cuts: 0 }, walk: { n: 5, max: 5000, cuts: 0 } });
        const bot = mkBot({ move: () => {} });
        const ok = await goToPosition(bot, -152.49977, 41, 108.478, 3);
        assert.strictEqual(ok, false, `output: ${bot.output}`);
        // the OLD bug path was goToGoal returning true and goToPosition logging the
        // distance-only "unable to reach" line; the walk must now fail at the goal check.
        assert.match(bot.output, /the goal is not satisfied/);
    });
    it('goToBed reports a refused sleep as false, not as an escaping exception', async () => {
        // mineflayer rejects bot.sleep() on ordinary game outcomes (monsters nearby, server
        // never confirming within 3 s: lib/plugins/bed.js); the live night_shelter step died
        // with "!!Code threw exception!! Error: bot is not sleeping" on 22 Nov 2026.
        const bot = Object.assign(new EventEmitter(), {
            registry,
            output: '',
            modes: { isOn: (m) => m === 'cheat' },   // goToPosition teleports and returns true
            findBlocks: () => [new Vec3(-24, 73, 50)],
            chat() {},
            blockAt: () => ({ name: 'red_bed' }),
            async sleep() { throw new Error('bot is not sleeping'); },
        });
        const ok = await goToBed(bot);
        assert.strictEqual(ok, false, `output: ${bot.output}`);
        assert.match(bot.output, /FAILED: could not sleep in the bed .* bot is not sleeping/);
    });
});
