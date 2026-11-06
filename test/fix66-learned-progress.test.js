/**
 * fix66: movement / run "no progress" learned from live movement, not constants.
 *
 * Root cause: fix44 (094b9db, #30) gave goToGoal a 1 s setInterval, a 0.5-block "moved" test and a 15 s no-progress limit;
 * fix27 (4dfd4e8) gave the Voyager run watchdog a 5 s poll and a 60 s limit. Neither knew how long a block of real movement
 * takes: digging (bot.digTime) or pillaring legitimately stands still, so a fixed 15 s cut healthy digs and the blame then
 * queued REPAIRs of travelTo (iMac log: travelTo(-116,42,76) "navigation stalled - no progress for 15s" right before
 * breakBlockAt(-116,42,76) succeeded, then "[psn] REPAIR travelTo [callee_fix] (evidence: FAILED: navigation stalled...)").
 *
 * Fix: utils/movement_model.js learns, per kind (walk/swim/build/dig, and the Voyager 'run' gap), the longest active time a
 * completed step took (digs as excess over the game's dig time), checked on the physics tick; unbounded + logged once until
 * learned; a bound applies only to gotos/runs that start after it was learned.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import Vec3 from 'vec3';
import Registry from 'prismarine-registry';
import * as mm from '../src/utils/movement_model.js';
import { goToGoal } from '../src/agent/library/skills.js';
import { Voyager } from '../src/agent/voyager.js';

const registry = Registry('1.20.4');
let clock = 0; const realNow = performance.now;
beforeEach(() => { clock = 0; performance.now = () => clock; mm._resetAnnouncementsForTest(); });
afterEach(() => { performance.now = realNow; });

function mkBot() {
    const bot = new EventEmitter();
    bot.registry = registry; bot.output = ''; bot.interrupt_code = false;
    bot.entity = { position: new Vec3(0.5, 64, 0.5), isInWater: false, isInLava: false };
    bot.pf = { moving: true, mining: false, building: false };
    bot.pathfinder = { isMoving: () => bot.pf.moving, isMining: () => bot.pf.mining, isBuilding: () => bot.pf.building,
        setMovements() {}, stop() { bot.stopped = true; }, getPathTo: async () => ({ status: 'success' }), goto: () => new Promise(() => {}) };
    bot.targetDigBlock = null;
    bot.digTime = (b) => b.ms;
    return bot;
}
const tick = (bot, ms, n = 1) => { for (let i = 0; i < n; i++) { clock += ms; bot.emit('physicsTick'); } };
const step = (bot, dx) => { bot.entity.position = bot.entity.position.offset(dx, 0, 0); };

describe('fix66: learned movement model', () => {
    it('before anything is learned the check is UNBOUNDED, said once per kind, never a default', () => {
        mm.setMovementStore({});
        const bot = mkBot(), said = [];
        let stalls = 0;
        const stop = mm.watchPathing(bot, () => stalls++, l => said.push(l));
        tick(bot, 50, 20 * 600);   // 10 min standing still while pathing
        stop();
        const stop2 = mm.watchPathing(bot, () => stalls++, l => said.push(l)); tick(bot, 50, 100); stop2();
        assert.strictEqual(stalls, 0);
        assert.strictEqual(said.length, 1);
        assert.match(said[0], /UNBOUNDED walk: no completed walk step learned/);
    });

    it('the store must be a real object (no silent default)', () => {
        assert.throws(() => mm.setMovementStore(null), /store must be an object/);
    });

    it('learns time per block from fresh cells; bobbing in a cell or returning to a seen cell is not progress', () => {
        const store = {}; mm.setMovementStore(store);
        const bot = mkBot();
        const stop = mm.watchPathing(bot, () => assert.fail('no bound yet'), () => {});
        tick(bot, 50, 5); step(bot, 1); tick(bot, 50);               // 300 ms to the next cell
        bot.entity.position = bot.entity.position.offset(0.3, 0, 0); tick(bot, 50, 4);   // jitter inside the cell
        step(bot, -1); tick(bot, 50, 4);                              // back to a seen cell
        step(bot, 2); tick(bot, 50);                                  // fresh: 9 ticks after the last fresh cell
        stop();
        assert.deepStrictEqual(store.walk, { n: 2, max: 450, cuts: 0 });   // 300 ms, then 450 ms (jitter + back to a seen cell)
    });

    it('a learned bound only applies to gotos that start after it; then cuts and counts the cut', () => {
        const store = { walk: { n: 3, max: 400, cuts: 0 } }; mm.setMovementStore(store);
        const bot = mkBot(); let v = null;
        const stop = mm.watchPathing(bot, x => { v = x; }, () => {});
        tick(bot, 50, 8); assert.strictEqual(v, null);    // 400 ms: within the longest completed step
        tick(bot, 50, 1); stop();
        assert.strictEqual(v.kind, 'walk'); assert.strictEqual(v.bound.ms, 400); assert.strictEqual(store.walk.cuts, 1);
        // a kind learned during a goto does not bound that goto
        const s2 = {}; mm.setMovementStore(s2);
        const b2 = mkBot(); let fired = false;
        const st2 = mm.watchPathing(b2, () => { fired = true; }, () => {});
        tick(b2, 50, 2); step(b2, 1); tick(b2, 50); tick(b2, 50, 200); st2();
        assert.strictEqual(s2.walk.n, 1); assert.strictEqual(fired, false);
    });

    it('thinking time (pathfinder not acting) is not counted', () => {
        mm.setMovementStore({ walk: { n: 1, max: 100, cuts: 0 } });
        const bot = mkBot(); bot.pf.moving = false; let fired = false;
        const stop = mm.watchPathing(bot, () => { fired = true; }, () => {});
        tick(bot, 50, 1000); stop();
        assert.strictEqual(fired, false);
    });

    it('a dig is allowed the game dig time of its block plus the learned excess: a long dig is not a stall', () => {
        const store = { walk: { n: 5, max: 300, cuts: 0 }, dig: { n: 2, max: 250, cuts: 0 } }; mm.setMovementStore(store);
        const bot = mkBot(); let v = null;
        const stop = mm.watchPathing(bot, x => { v = x; }, () => {});
        bot.pf.mining = true; bot.targetDigBlock = { ms: 20000 };   // e.g. stone by hand / obsidian
        tick(bot, 50, 405); assert.strictEqual(v, null, '20.25 s of a 20 s dig + 250 ms excess is still progress');
        tick(bot, 50, 1); stop();
        assert.strictEqual(v.kind, 'dig'); assert.strictEqual(v.bound.ms, 20250);
    });

    it('a completed dig is progress and is learned as excess over its dig time', () => {
        const store = {}; mm.setMovementStore(store);
        const bot = mkBot();
        const stop = mm.watchPathing(bot, () => {}, () => {});
        bot.pf.mining = true; bot.targetDigBlock = { ms: 1000 };
        tick(bot, 50, 26); bot.pf.mining = false; bot.targetDigBlock = null; tick(bot, 50); stop();
        assert.deepStrictEqual(store.dig, { n: 1, max: 350, cuts: 0 });   // 1350 ms active - 1000 ms dig time
    });
});

describe('fix66: goToGoal uses the learned verdict on the physics tick', () => {
    it('stalls with the learned numbers in the FAILED line', async () => {
        mm.setMovementStore({ walk: { n: 4, max: 1000, cuts: 0 } });
        const bot = mkBot();
        const p = goToGoal(bot, new (await import('mineflayer-pathfinder')).default.goals.GoalNear(50, 64, 0, 1));
        await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
        tick(bot, 50, 25);
        assert.strictEqual(await p, false);
        assert.match(bot.output, /FAILED: navigation stalled - no walk progress for 1050ms active, longer than all 4 completed walk steps learned \(longest 1000ms\)/);
        assert.ok(bot.stopped);
        assert.strictEqual(bot.listenerCount('physicsTick'), 0);
    });

    it('unlearned: does not cut, ends when the pathfinder ends', async () => {
        mm.setMovementStore({});
        const bot = mkBot(); let finish;
        bot.pathfinder.goto = () => new Promise(r => { finish = r; });
        const p = goToGoal(bot, new (await import('mineflayer-pathfinder')).default.goals.GoalNear(50, 64, 0, 1));
        await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
        tick(bot, 50, 20 * 60);
        finish();
        assert.strictEqual(await p, true);
        assert.strictEqual(bot.listenerCount('physicsTick'), 0);
    });
});

describe('fix66: Voyager run watchdog is learned', () => {
    function mkVoyager(bot) {
        const v = Object.create(Voyager.prototype);
        v._prepareTossSignals = () => {}; v._getInventoryWithEquipment = () => ({});
        bot.inventory = { slots: new Array(46).fill(null) }; bot.findBlock = () => null; bot.currentWindow = null;
        let stopRun;
        v.agent = { bot, actions: { executing: true, stop() { v.stoppedAt = clock; stopRun(); },
            runAction: (label, fn) => new Promise(r => { stopRun = () => r({ message: 'stopped' }); v.finish = () => r({ message: 'ok' }); }) } };
        return v;
    }
    it('unbounded (logged once) until a gap is learned; then stops past the longest completed gap', async () => {
        const store = {}; mm.setMovementStore(store);
        const bot = mkBot(); const v = mkVoyager(bot);
        const r1 = v._run('t1', async () => {});
        tick(bot, 50, 10); bot.inventory.slots[36] = { name: 'dirt', count: 1 }; tick(bot, 50);   // progress after 500 ms
        tick(bot, 50, 20 * 300);                                                       // standing still: unbounded
        v.finish(); await r1;
        assert.strictEqual(v._stall, null);
        assert.deepStrictEqual(store.run, { n: 1, max: 500, cuts: 0 });
        const r2 = v._run('t2', async () => {});
        tick(bot, 50, 11); await r2;
        assert.ok(v._stall); assert.match(v._stall.why, /550ms, longer than all 1 completed gaps learned \(longest 500ms\)/);
        assert.strictEqual(store.run.cuts, 1);
        assert.strictEqual(bot.listenerCount('physicsTick'), 0);
    });
});

describe('fix66: the constants are gone', () => {
    it('no fixed poll/limit/"moved" constants in goToGoal or the run watchdog', () => {
        const sk = fs.readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
        const vo = fs.readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
        assert.ok(!/NO_PROGRESS_TIMEOUT|PROGRESS_CHECK_INTERVAL|moved < 0\.5/.test(sk));
        assert.ok(!/since >= 60e3|for 60s at/.test(vo));
        assert.match(vo, /setMovementStore\(this\.progress\.movement\)/);
    });
});
