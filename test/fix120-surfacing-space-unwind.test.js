/**
 * fix120 (live icefox2000, 15 Nov 2026, 20:35-21:10 GMT):
 * A. Drowning death at -174,51,106 during a replayed goToNearestBlock(crafting_table):
 *    self_preservation's water assist only jumps when no pathfinder goal is set, so a path
 *    across open water stayed submerged (oxygen 4 -> -1, log 16364). Added an emergency
 *    surfacing branch that interrupts whatever holds the bot once half the air supply is gone.
 * B. The interrupt could not unwind bot.waitForTicks (mineflayer waits raw physics ticks; the
 *    inserted `if(bot.interrupt_code) return;` guards run only after an await resolves):
 *    action_manager.stop() escalated after 10 s ("Code execution refused to stop") and
 *    cleanKilled the process -> full restart + "left no watchdog evidence" gate error.
 *    requestInterrupt (agent.js) now emits 'interrupt_code_set' and the wrapped tick wait
 *    resolves on it, like the endowed library calls (coder.js:1225) resolve false.
 * C. With 0-1 empty slots the curriculum kept proposing "Obtain 1 rotten_flesh / spider_eye /
 *    tropical_fish" and "Obtain 4 glass_bottle" and each burned 4 attempts ("INVENTORY FULL
 *    DETECTED"). _rejectTask now refuses item goals the inventory cannot hold (same roomFor
 *    math as fix92; Minecraft pickup rule, minecraft.wiki/w/Inventory), feeding the
 *    free-space hint into the fix90 re-proposal loop.
 * D. "[fix86] __psnTrace missing when recording failure" (90 log lines): when every codegen
 *    attempt died at lint/staging the failure recorder demanded a trace no run produced, threw,
 *    and skipped the _lastCutKind reset — polluting the next task's attribution. It now records
 *    "no generated attempt executed" and resets.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

import { installInterruptibleWaitForTicks } from '../src/utils/interruptible_wait.js';
import minecraftData from 'minecraft-data';
import { _setVersionForTest } from '../src/utils/mcdata.js';

// same version constant as test/fix97-root.test.js:33 (the version the bot logs in as)
const VER = '1.20.4';
const md = minecraftData(VER);
_setVersionForTest(VER);   // validateTask -> knownNames -> getAllItems needs the item lists

describe('fix120 B: waitForTicks ends when the interrupt arrives', () => {
    // the "never ends on its own" waits below are pending promises with NO timer handle, so the
    // test process can exit once the wrapper resolves them via the interrupt event
    function fakeBot(neverEnds = true) {
        const bot = new EventEmitter();
        bot.interrupt_code = false;
        bot.waitForTicks = neverEnds
            ? () => new Promise(() => { })
            : (ticks) => new Promise((resolve) => setTimeout(resolve, ticks * 10));
        installInterruptibleWaitForTicks(bot);
        return bot;
    }
    it('resolves early on interrupt_code_set instead of waiting out the ticks', async () => {
        const bot = fakeBot();
        const started = Date.now();
        await Promise.all([
            bot.waitForTicks(10000),
            new Promise((r) => setTimeout(() => { bot.interrupt_code = true; bot.emit('interrupt_code_set'); r(); }, 20)),
        ]);
        assert.ok(Date.now() - started < 1000, 'the wait ended on the event, not 500 s of ticks');
    });
    it('resolves immediately when interrupt_code is already set', async () => {
        const bot = fakeBot();
        bot.interrupt_code = true;
        await bot.waitForTicks(100000);
    });
    it('normal waits still resolve and the listener is removed (no leak)', async () => {
        const bot = fakeBot(false);
        await bot.waitForTicks(1);
        assert.strictEqual(bot.listenerCount('interrupt_code_set'), 0);
    });
    it('a rejecting original wait rejects (no error swallowing)', async () => {
        const bot = new EventEmitter();
        bot.interrupt_code = false;
        bot.waitForTicks = () => Promise.reject(new Error('orig boom'));
        installInterruptibleWaitForTicks(bot);
        await assert.rejects(bot.waitForTicks(1), /orig boom/);
    });
    it('installing twice is a no-op, installing without waitForTicks fails loud', () => {
        const bot = fakeBot();
        const wrapped = bot.waitForTicks;
        installInterruptibleWaitForTicks(bot);
        assert.strictEqual(bot.waitForTicks, wrapped);
        assert.throws(() => installInterruptibleWaitForTicks(new EventEmitter()), /not a function at install time/);
    });
    it('requestInterrupt emits interrupt_code_set; mcdata installs the wrapper', () => {
        const agent_src = readFileSync('src/agent/agent.js', 'utf8');
        const mcdata_src = readFileSync('src/utils/mcdata.js', 'utf8');
        assert.match(agent_src, /this\.bot\.emit\('interrupt_code_set'\);/);
        assert.match(mcdata_src, /installInterruptibleWaitForTicks\(bot\);/);
    });
});

describe('fix120 A: the drowning emergency fires at half air supply', async () => {
    const modes_src = readFileSync('src/agent/modes.js', 'utf8');
    const { drowningEmergency, AIR_SUPPLY_MAX, AIR_EMERGENCY } = await import('../src/agent/modes.js');
    it('constants follow mineflayer breath.js (air metadata / 15, max 20)', () => {
        assert.strictEqual(AIR_SUPPLY_MAX, 20);
        assert.strictEqual(AIR_EMERGENCY, 10);
    });
    it('undefined oxygen (never submerged) is not an emergency; <= half is', () => {
        assert.strictEqual(drowningEmergency({}), false);
        assert.strictEqual(drowningEmergency({ oxygenLevel: 20 }), false);
        assert.strictEqual(drowningEmergency({ oxygenLevel: 11 }), false);
        assert.strictEqual(drowningEmergency({ oxygenLevel: 10 }), true);
        assert.strictEqual(drowningEmergency({ oxygenLevel: 4 }), true);   // the live death path
    });
    it('the water branch surfaces via execute() even while a path holds the bot', () => {
        // the assist that skipped when a path was running must now be the else branch
        assert.match(modes_src, /if \(drowningEmergency\(bot\)\) \{[\s\S]*?execute\(this, agent,[\s\S]*?setGoal\(null\)[\s\S]*?setControlState\('jump', true\)[\s\S]*?\}\s*\/\/ does not call execute so does not interrupt other actions\s*\n\s*else if \(!bot\.pathfinder\.goal\)/);
    });
});

describe('fix120 C: _rejectTask refuses item goals the inventory cannot hold', () => {
    let Voyager;
    before(async () => {
        const mod = await import('../src/agent/voyager.js');
        mod._setVersionForTest(VER);   // countGoal's registry (the live login handler sets this)
        Voyager = mod.Voyager;
    });
    // 36 stackable slots (PLAYER_WINDOW 9..45); fill all but leave the goal item out
    function rigBot(fillerCounts) {
        const slots = new Array(46).fill(null);
        let i = 9;
        for (const [name, count] of fillerCounts) slots[i++] = { name, count };
        return {
            registry: md,
            inventory: { slots, inventoryStart: 9, inventoryEnd: 45 },
        };
    }
    function rig(bot) {
        const v = Object.create(Voyager.prototype);
        v.agent = { name: 'testbot', bot };
        v.skills = [];
        v.progress = { goalStats: {}, goalFailures: {}, failed: [], blockers: [] };
        return v;
    }
    const full = () => Array.from({ length: 36 }, (_, k) => [`cobblestone`, k < 35 ? 64 : 63]);
    it('rejects an obtain goal with 0 room (the live rotten_flesh case)', () => {
        const why = rig(rigBot(full()))._rejectTask('Obtain 1 rotten_flesh', true, null);
        assert.match(String(why), /cannot hold 1 rotten_flesh \(room for 0\)/);
        assert.match(String(why), /tossClutter|depositToChest/);
    });
    it('rejects a craft goal with no output slot even when materials are held', () => {
        const filler = Array.from({ length: 36 }, (_, k) => [k === 0 ? 'cobblestone' : 'diorite', 64]);
        assert.match(String(rig(rigBot(filler))._rejectTask('Craft 1 stone_pickaxe', true, null)), /cannot hold 1 stone_pickaxe/);
    });
    it('a partial stack of the goal item reopens the goal (room 1 accepts 1)', () => {
        const filler = [['rotten_flesh', 63], ...Array.from({ length: 35 }, () => ['cobblestone', 64])];
        assert.strictEqual(rig(rigBot(filler))._rejectTask('Obtain 1 rotten_flesh', true, null), null);
    });
    it('one empty slot fits 1 of anything (64 room) — proposal proceeds', () => {
        const filler = Array.from({ length: 35 }, () => ['cobblestone', 64]);
        assert.strictEqual(rig(rigBot(filler))._rejectTask('Obtain 1 spider_eye', true, null), null);
    });
    it('non-item goals are not capacity-gated', () => {
        assert.strictEqual(rig(rigBot(full()))._rejectTask('Explore the area for iron ore', true, null), null);
    });
    it('no bot yet (constructor-time parsing, fix52) skips the gate instead of throwing', () => {
        assert.strictEqual(rig(undefined)._rejectTask('Obtain 1 rotten_flesh', true, null), null);
    });
});

describe('fix120 D: failure recording does not demand a trace from unexecuted attempts', () => {
    it('the missing-trace throw is replaced by an explicit no-attribution + cut-kind reset', () => {
        const src = readFileSync('src/agent/voyager.js', 'utf8');
        assert.doesNotMatch(src, /__psnTrace missing when recording failure/);
        assert.match(src, /no generated attempt executed \(cut: \$\{anyCut\}\); nothing to attribute, not blaming/);
        // an executed attempt that loses its trace must still fail loud (8455 guard)
        assert.match(src, /ran and left no __psnTrace/);
    });
});
