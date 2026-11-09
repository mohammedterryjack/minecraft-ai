/**
 * fix69: the five swallowed catches in src/agent/library/skills.js.
 *  - craftRecipe (L197) `try { bot.closeWindow(bot.currentWindow || bot.inventory) } catch (e) {}`  (b2e2338)
 *  - pickupNearbyItems (L818) `try { await goToGoal(...) } catch (e) {}`                           (b2e2338)
 *  - equip / consume finally (L1168 / L1383) `try { await bot.closeWindow(bot.currentWindow) } catch (e) {}`  (094b9db, #30)
 *  - goToBed (L2119) `await bot.wake().catch(() => {})`                                              (b2e2338)
 * The first block runs the real mineflayer 4.39 inventory and bed plugins, to pin down what can actually throw.
 * The rest drive the skills against mocks: an open window is closed, no window means nothing to close, and a bug inside
 * the cleanup now surfaces instead of being swallowed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import Registry from 'prismarine-registry';
import { _setVersionForTest } from '../src/utils/mcdata.js';
import { PLAYER_WINDOW } from '../src/utils/carried.js';

const require = createRequire(import.meta.url);
const injectInventory = require('mineflayer/lib/plugins/inventory.js');
const injectBed = require('mineflayer/lib/plugins/bed.js');
const VERSION = '1.20.4';   // the live server version behind ViaProxy
_setVersionForTest(VERSION);

function realMineflayerBot() {
    const registry = Registry(VERSION);
    const bot = new EventEmitter();
    bot.registry = registry;
    bot.version = VERSION;
    bot.supportFeature = registry.supportFeature;
    bot.entity = { id: 1 };
    const written = [];
    bot._client = new EventEmitter();
    bot._client.write = (name, params) => written.push({ name, params });
    injectInventory(bot, { hideErrors: true });
    injectBed(bot);
    return { bot, written };
}

describe('fix69: what mineflayer 4.39 can actually throw', () => {
    it('closeWindow(null) is a TypeError: the only throw, and only from a null window', () => {
        const { bot } = realMineflayerBot();
        assert.throws(() => bot.closeWindow(null), TypeError);
        assert.throws(() => bot.closeWindow(undefined), TypeError);
    });

    it('closeWindow(bot.inventory) does not throw, but sends close_window 0 and emits a spurious windowClose', async () => {
        const { bot, written } = realMineflayerBot();
        const closed = [];
        bot.on('windowClose', w => closed.push(w));
        await bot.closeWindow(bot.inventory);
        assert.deepStrictEqual(written.map(w => [w.name, w.params.windowId]), [['close_window', 0]]);
        assert.deepStrictEqual(closed, [bot.inventory]);
    });

    it('closing an already-closed window does not throw (it resends close_window): a state to check, not a catch', async () => {
        const { bot, written } = realMineflayerBot();
        const windows = require('prismarine-windows')(VERSION);
        const table = windows.createWindow(3, 'minecraft:crafting', 'Crafting');
        bot.currentWindow = table;
        await bot.closeWindow(table);
        assert.strictEqual(bot.currentWindow, null);
        await bot.closeWindow(table);
        assert.deepStrictEqual(written.map(w => w.name), ['close_window', 'close_window']);
    });

    it("wake() rejects only with 'already awake' when not sleeping; while sleeping it sends entity_action", async () => {
        const { bot, written } = realMineflayerBot();
        await assert.rejects(bot.wake(), /already awake/);
        bot.isSleeping = true;
        await bot.wake();
        assert.deepStrictEqual(written.map(w => [w.name, w.params.actionId]), [['entity_action', 2]]);
    });
});

function skillBot(over = {}) {
    const bot = {
        output: '',
        interrupt_code: false,
        currentWindow: null,
        game: { gameMode: 'survival' },
        inventory: { slots: new Array(PLAYER_WINDOW.size).fill(null), inventoryStart: PLAYER_WINDOW.mainStart, inventoryEnd: PLAYER_WINDOW.offHand, items() { return this.slots.filter(Boolean); }, emptySlotCount: () => 30,
            findInventoryItem(name) { return this.slots.find(s => s && s.name === name); } },
        closed: [],
        async closeWindow(w) { if (w == null) throw new TypeError("Cannot read properties of null (reading 'id')"); this.closed.push(w); this.currentWindow = null; },
        pathfinder: { setMovements() {}, stop() {}, goto: async () => {} },
        entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 1 } },
        registry: Registry(VERSION),
        heldItem: null,
        modes: { isOn: () => true, pause() {}, unpause() {} },
        chat() {},
        on() {},
        removeListener() {},
        ...over,
    };
    return bot;
}

describe('fix69: craftRecipe after a failed bot.craft', () => {
    const stickBot = (over) => skillBot({ recipesFor: () => [{}], craft: async () => { throw new Error('craft failed'); }, ...over });

    it('no window open: nothing is closed (the old `|| bot.inventory` closed the player inventory)', async () => {
        const { craftRecipe } = await import('../src/agent/library/skills.js');
        const bot = stickBot();
        assert.strictEqual(await craftRecipe(bot, 'stick'), false);
        assert.deepStrictEqual(bot.closed, []);
        assert.match(bot.output, /Crafting stick FAILED: craft failed/);
    });

    it('a window left open by the failed craft is closed', async () => {
        const { craftRecipe } = await import('../src/agent/library/skills.js');
        const table = { id: 3, type: 'minecraft:crafting' };
        const bot = stickBot({ currentWindow: table });
        assert.strictEqual(await craftRecipe(bot, 'stick'), false);
        assert.deepStrictEqual(bot.closed, [table]);
    });

    it('a bug inside closeWindow surfaces instead of being swallowed', async () => {
        const { craftRecipe } = await import('../src/agent/library/skills.js');
        const bot = stickBot({ currentWindow: { id: 3, type: 'minecraft:crafting' }, closeWindow: async () => { throw new Error('closeWindow bug'); } });
        await assert.rejects(craftRecipe(bot, 'stick'), /closeWindow bug/);
    });
});

describe('fix69: equip / consume window cleanup in finally', () => {
    it('equip closes a non-inventory window, and a closeWindow bug is not swallowed', async () => {
        const { equip } = await import('../src/agent/library/skills.js');
        const sword = { name: 'iron_sword', type: 1 };
        const table = { id: 3, type: 'minecraft:crafting' };
        let bot = skillBot({ equip: async function () { this.currentWindow = table; } });
        bot.inventory.slots[36] = sword;
        assert.strictEqual(await equip(bot, 'iron_sword'), true);
        assert.deepStrictEqual(bot.closed, [table]);

        bot = skillBot({ equip: async function () { this.currentWindow = table; }, closeWindow: async () => { throw new Error('closeWindow bug'); } });
        bot.inventory.slots[36] = sword;
        await assert.rejects(equip(bot, 'iron_sword'), /closeWindow bug/);
    });

    it('equip leaves the player inventory window alone (state check, not a catch)', async () => {
        const { equip } = await import('../src/agent/library/skills.js');
        const inv = { id: 0, type: 'minecraft:inventory' };
        const bot = skillBot({ currentWindow: inv, equip: async () => {} });
        bot.inventory.slots[36] = { name: 'iron_sword', type: 1 };
        assert.strictEqual(await equip(bot, 'iron_sword'), true);
        assert.deepStrictEqual(bot.closed, []);
    });

    it('consume closes a window opened during the eat, and a closeWindow bug is not swallowed', async () => {
        const { consume } = await import('../src/agent/library/skills.js');
        const chest = { id: 4, type: 'minecraft:generic_9x3' };
        const bread = { name: 'bread', type: 2, count: 5 };
        let bot = skillBot({ food: 10, equip: async function (it) { this.heldItem = it; }, consume: async function () { this.currentWindow = chest; this.food = 15; } });
        bot.inventory.slots[36] = bread;
        assert.strictEqual(await consume(bot, 'bread'), true);
        assert.deepStrictEqual(bot.closed, [chest]);

        bot = skillBot({ food: 10, equip: async function (it) { this.heldItem = it; }, consume: async function () { this.currentWindow = chest; this.food = 15; },
            closeWindow: async () => { throw new Error('closeWindow bug'); } });
        bot.inventory.slots[36] = bread;
        await assert.rejects(consume(bot, 'bread'), /closeWindow bug/);
    });
});

describe('fix69: pickupNearbyItems uses goToGoal\'s result instead of catching', () => {
    const item = { name: 'item', isValid: true, width: 0.25, position: { x: 3, y: 64, z: 0 }, getDroppedItem() { return { name: 'oak_log', count: 1 }; } };

    it('an interrupt (goToGoal -> false) ends the pickup with false instead of retrying', async () => {
        const { pickupNearbyItems } = await import('../src/agent/library/skills.js');
        const bot = skillBot({ interrupt_code: true, nearestEntity: () => item });
        assert.strictEqual(await pickupNearbyItems(bot), false);
        assert.match(bot.output, /FAILED: navigation cancelled \(interrupted\)/);
        assert.match(bot.output, /Picked up 0 items before being interrupted/);
    });

    it('a bug inside goToGoal now surfaces (it was swallowed and reported as "Picked up 0 items")', async () => {
        const { pickupNearbyItems } = await import('../src/agent/library/skills.js');
        // a registry without 'glass': pickupNearbyItems' own Movements build fine, goToGoal's glass lookup is the bug
        const reg = Registry(VERSION);
        const { glass, ...noGlass } = reg.blocksByName;
        const registry = Object.create(reg, { blocksByName: { value: noGlass } });
        const bot = skillBot({ nearestEntity: () => item, registry });
        await assert.rejects(pickupNearbyItems(bot), /reading 'id'/);
        assert.doesNotMatch(bot.output, /Picked up 0 items/);
    });
});

describe('fix69: goToBed wakes without swallowing', () => {
    it('interrupted while sleeping: wake() is called once (it cannot reject while isSleeping) and the skill returns false', async () => {
        const { goToBed } = await import('../src/agent/library/skills.js');
        let wakes = 0;
        const bot = skillBot({
            interrupt_code: false,
            findBlocks: () => [{ x: 1, y: 64, z: 1 }],
            blockAt: () => ({ name: 'red_bed' }),
            isSleeping: false,
            async sleep() { this.isSleeping = true; this.interrupt_code = true; },
            async wake() { if (!this.isSleeping) throw new Error('already awake'); wakes++; },
        });
        assert.strictEqual(await goToBed(bot), false);
        assert.strictEqual(wakes, 1);
        assert.match(bot.output, /Interrupted; got out of bed/);
    });
});
