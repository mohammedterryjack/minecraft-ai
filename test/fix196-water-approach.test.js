/**
 * fix196 (live icefox2000, 25 Nov 2026): the cod chain never killed, never fed.
 * "approach cod" x3 and "Smelt 3 cod into 3 cooked_cod" failed at a pond ~57 blocks away.
 * Two root causes, both in the close-the-distance step of attacking:
 *  1. mineflayer-pvp enforces attackRange = 3.5 (PVP.js:41,163: beyond it pvp.attack returns
 *     targetTooFar unsent), but fix185 only approached when distance > 5 and walked with
 *     goToPosition's default min_distance = 2 — a target 3.5-5 blocks away was swung at from
 *     out of range.
 *  2. pathfinder 2.4.5 refuses every liquid node ("dont go underwater" — movements.js:526,
 *     544,554), so a swimming cod has no GoalNear node and walking can NEVER end in melee
 *     range of it (live: every attempt stalled at the pond shore). The library already owns
 *     the game's liquid movement (swimTowards) — attackEntity must use it for aquatic mobs.
 *  3. goToMob.approach() returned true on merely *seeing* a mob, ignoring navigation failure,
 *     so killMob attacked 50-block-away "approached" targets.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import { attackEntity } from '../src/agent/library/skills.js';

const registry = Registry('1.20.4');

// Fake world: land for x <= 0, a water body (surface at the bot's y) for x > 0.
// `shore` decides whether the bot's cell has water in front of it.
function mkBot({ mob = 'cod', distance = 20, pathStatus = 'noPath', shore = true } = {}) {
    const entity = { id: 7, name: mob, position: new Vec3(distance, 33, 0), metadata: [] };
    const bot = Object.assign(new EventEmitter(), {
        registry,
        output: '',
        interrupt_code: false,
        entity: { position: new Vec3(0, 33, 0), isInWater: false },
        entities: { 7: entity },
        inventory: { items: () => [] },
        controls: {},
        setControlState(name, val) {
            bot.controls[name] = val;
            // fake physics: walking forward from the shore cell enters the water
            if (name === 'forward' && val && shore) bot.entity.isInWater = true;
        },
        async lookAt() {},
        nearestEntity: () => null,
        blockAt: (p) => {
            const water = shore && p.x > 0 && p.y <= 33;
            return { name: water ? 'water' : 'air', liquid: water, isEmpty: !water };
        },
        modes: { isOn: () => false },
        pathfinder: {
            pathCalls: 0,
            setMovements() {}, stop() {}, async goto() {}, setGoal() {},
            isMining: () => false, isBuilding: () => false, isMoving: () => false,
            async getPathTo() { bot.pathfinder.pathCalls++; return { status: pathStatus }; },
        },
        pvp: {
            attacks: 0, stopped: 0,
            attack() { bot.pvp.attacks++; setTimeout(() => { delete bot.entities[7]; }, 10); },
            stop() { bot.pvp.stopped++; },
        },
        async equipItem() { return true; },
        heldItems: [],
        async waitForTicks(n) {
            await new Promise((r) => setTimeout(r, Math.min(n, 10)));
            // fake swimming: while in water with forward held, close on the target column
            if (bot.entity.isInWater && bot.controls.forward)
                bot.entity.position.x += 3;
        },
    });
    bot._entity = entity;
    return bot;
}

describe('fix196 melee approach ends inside pvp attack range, swimming the water leg', () => {
    it('aquatic target across a water body: enter the water, swim the column, attack in range', async () => {
        const bot = mkBot({ mob: 'cod', distance: 20, shore: true });
        assert.strictEqual(await attackEntity(bot, bot._entity, true), true);
        assert.ok(bot.entity.isInWater, 'bot never entered the water body in front of it');
        assert.ok(bot.pvp.attacks >= 1, 'no swing after the swim approach');
        assert.ok(bot.entity.position.distanceTo(bot._entity.position) <= 3.5,
            `attacked from ${bot.entity.position.distanceTo(bot._entity.position).toFixed(1)} blocks (> pvp attackRange 3.5, PVP.js:41)`);
        assert.match(bot.output, /Successfully killed cod/);
    });

    it('aquatic target with no water to enter from here: fail honestly, no swings', async () => {
        const bot = mkBot({ mob: 'cod', distance: 20, shore: false });
        const t0 = Date.now();
        assert.strictEqual(await attackEntity(bot, bot._entity, true), false);
        assert.ok(Date.now() - t0 < 5000, 'must fail fast, not wander');
        assert.strictEqual(bot.pvp.attacks, 0, 'pvp.attack called while target out of reach');
        assert.ok(!bot.controls.forward, 'entered blind water-walk with no water in front');
        assert.match(bot.output, /could not reach cod/);
    });

    it('land target with no path: fail fast at the walk stage, no water entry attempted', async () => {
        const bot = mkBot({ mob: 'zombie', distance: 31, pathStatus: 'noPath', shore: true });
        const t0 = Date.now();
        assert.strictEqual(await attackEntity(bot, bot._entity, true), false);
        assert.ok(Date.now() - t0 < 5000, 'unreachable land target must fail fast');
        assert.strictEqual(bot.pvp.attacks, 0, 'pvp.attack called while target out of reach');
        assert.match(bot.output, /could not reach zombie/);
    });

    it('land target 4 blocks away with a walkable goal: approach to melee range, then swing', async () => {
        const bot = mkBot({ mob: 'zombie', distance: 4, pathStatus: 'success', shore: false });
        // fake navigation: a found path ends the bot at the goal node (within 3.5)
        bot.pathfinder.goto = async () => { bot.entity.position.x = 4; };
        assert.strictEqual(await attackEntity(bot, bot._entity, true), true);
        assert.ok(bot.pvp.attacks >= 1, 'no swing after a successful walk approach');
    });
});
