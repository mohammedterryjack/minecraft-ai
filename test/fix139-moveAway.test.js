import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import * as skillsLib from '../src/agent/library/skills.js';
import { setMovementStore } from '../src/utils/movement_model.js';
const movementStoreFixture = () => ({ walk: { n: 5, max: 5000, cuts: 0 }, swim: { n: 5, max: 2000, cuts: 0 }, dig: { n: 5, max: 9000, cuts: 0 }, build: { n: 5, max: 9000, cuts: 0 } });

// fix139: moveAway() returned true unconditionally — goToGoal's failure was swallowed. Live
// 17 Nov 2026: bot at food 14 health 6 under attack inside its own dug shaft; self_preservation's
// low-health branch (modes.js, damage < 3 s ago) re-called moveAway(bot, 20) on every damage
// tick, each call "succeeded" without moving, and the mode hot-looped ~230 ms per iteration
// ("Mode self_preservation finished executing" x329) until the bot starved in place.
// Contract: true only if the bot actually ended >= 1 block from where it started.

const registry = Registry('1.20.4');

function makeBot({ startPos, pathStatus = 'noPath', onGoto = null }) {
    const bot = Object.assign(new EventEmitter(), {
        registry,
        output: '',
        food: 14,
        health: 6,
        interrupt_code: false,
        game: { gameMode: 'survival' },
        entity: { position: startPos, isInWater: false, isInLava: false },
        modes: { isOn: () => false },
        blockAt: () => null,
        setControlState() {},
    });
    bot.pathfinder = {
        setMovements() {},
        setGoal() {},
        stop() {},
        isMining: () => false,
        isBuilding: () => false,
        isMoving: () => false,
        async getPathTo() {
            return { status: pathStatus, path: [] };
        },
        async goto() {
            if (onGoto) return onGoto(bot);
            throw new Error('No path found');
        },
    };
    return bot;
}

test('moveAway returns false when both searches prove noPath (sealed shaft)', async () => {
    setMovementStore(movementStoreFixture());
    const bot = makeBot({ startPos: Vec3(-19, 56, 71), pathStatus: 'noPath' });
    const moved = await skillsLib.moveAway(bot, 20);
    assert.equal(moved, false);
    assert.match(bot.output, /FAILED/);
});

test('moveAway returns true when the pathfinder carries the bot away', async () => {
    setMovementStore(movementStoreFixture());
    const bot = makeBot({
        startPos: Vec3(0, 64, 0),
        pathStatus: 'success',
        onGoto: async (b) => {
            b.entity.position = Vec3(5, 64, 12);
        },
    });
    const moved = await skillsLib.moveAway(bot, 8);
    assert.equal(moved, true);
});

test('moveAway returns false when the pathfinder resolves but the bot never moved', async () => {
    setMovementStore(movementStoreFixture());
    const bot = makeBot({
        startPos: Vec3(-19, 56, 71),
        pathStatus: 'success',
        onGoto: async () => {
            /* bot stays put */
        },
    });
    const moved = await skillsLib.moveAway(bot, 20);
    assert.equal(moved, false);
    assert.match(bot.output, /could not move away/);
});

test('moveAway returns false when the pathfinder throws', async () => {
    setMovementStore(movementStoreFixture());
    const bot = makeBot({
        startPos: Vec3(-19, 56, 71),
        pathStatus: 'success',
        onGoto: async () => {
            throw new Error('No path found');
        },
    });
    const moved = await skillsLib.moveAway(bot, 20);
    assert.equal(moved, false);
});
