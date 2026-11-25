/**
 * fix181 (live icefox2000 23-24 Nov 2026): while the task navigated toward a tree, the
 * self_defense mode's goto replaced the pathfinder goal; mineflayer-pathfinder rejected our
 * pending goto with name='GoalChanged' ("The goal was changed before it could be completed!",
 * node_modules/mineflayer-pathfinder/lib/goto.js:33-35) — deferred through setTimeout(goto.js:
 * 47-53) so by the time goToGoal's catch ran, the new action had already reset
 * bot.interrupt_code (action_manager.js _executeAction). The fix44 interrupt branch missed it,
 * the failure fell into the generic "FAILED: navigation error:", and PSN attributed the
 * takeover to the learned code (mindcraft.log ~59829: 6x inside mine5OakLogs retries).
 * goToGoal now classifies GoalChanged as a cancellation by takeover — returns false without
 * calling pathfinder.stop(), which would emit path_stop and reject the takeover's own goto.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import pf from 'mineflayer-pathfinder';
import { goToGoal } from '../src/agent/library/skills.js';
import { setMovementStore } from '../src/utils/movement_model.js';

const registry = Registry('1.20.4');

function mkBot({ gotoErr, stopOnErr }) {
    const bot = Object.assign(new EventEmitter(), {
        registry,
        output: '',
        interrupt_code: false,   // fix181's whole point: the new action already cleared it
        game: { gameMode: 'survival' },
        entity: { position: new Vec3(-140.5, 48, 90.5), isInWater: false },
        modes: { isOn: () => false },
        inventory: { items: () => [] },
        setControlState() {},
        async lookAt() {},
        blockAt() { return { name: 'air', liquid: false }; },
        async waitForTicks(n) { for (let t = 0; t < n; t++) await Promise.resolve(); },
        pathfinder: {
            setMovements() {},
            stopCalls: 0,
            stop() { bot.pathfinder.stopCalls++; },
            isMoving() { return false; },
            isMining() { return false; },
            isBuilding() { return false; },
            async getPathTo() { return { status: 'success' }; },
            async goto() {
                const e = new Error(stopOnErr ? 'Path was stopped before it could be completed!' : 'The goal was changed before it could be completed!');
                e.name = stopOnErr ? 'PathStopped' : 'GoalChanged';
                throw e;
            },
        },
    });
    return bot;
}

describe('fix181: GoalChanged is a takeover cancellation, not a task navigation error', () => {
    it('returns false, says takeover, and never calls pathfinder.stop()', async () => {
        setMovementStore({ swim: { n: 5, max: 200, cuts: 0 }, walk: { n: 5, max: 5000, cuts: 0 } });
        const bot = mkBot({});
        const goal = new pf.goals.GoalNear(-140, 78, 90, 3);
        const ok = await goToGoal(bot, goal);
        assert.strictEqual(ok, false, `output: ${bot.output}`);
        assert.match(bot.output, /navigation cancelled: another action replaced the pathfinder goal \(takeover\)/);
        assert.doesNotMatch(bot.output, /navigation error: The goal was changed/, 'must not fall into the generic navigation-error branch');
        assert.strictEqual(bot.pathfinder.stopCalls, 0, 'stop() would emit path_stop and kill the takeover action\'s own goto');
    });
    it('other path errors keep their existing path (PathStopped -> generic error, pathfinder stopped)', async () => {
        setMovementStore({ swim: { n: 5, max: 200, cuts: 0 }, walk: { n: 5, max: 5000, cuts: 0 } });
        const bot = mkBot({ stopOnErr: true });
        const goal = new pf.goals.GoalNear(-140, 78, 90, 3);
        const ok = await goToGoal(bot, goal);
        assert.strictEqual(ok, false, `output: ${bot.output}`);
        assert.match(bot.output, /navigation error: Path was stopped/, 'PathStopped keeps the pre-fix181 generic classification');
        assert.doesNotMatch(bot.output, /takeover/);
        assert.ok(bot.pathfinder.stopCalls > 0, 'own-error paths must still stop the pathfinder');
    });
});
