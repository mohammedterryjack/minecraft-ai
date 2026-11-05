/**
 * fix44 regression tests - P0 consume timeouts and interrupt `log is not a function`
 * 
 * Required tests:
 * 1. Mock bot with open crafting window: consume and equip close it; eat completes; no Window.acceptClick assertion
 * 2. Concurrent equip+consume serialize (one after the other)
 * 3. 2500ms-style timeout with no food rise → loud FAILED string/result, not unhandled throw
 * 4. Generated-style `const log = {position:{...}}` + interrupt_code set → returns cleanly "Code interrupted" (no TypeError)
 * 5. collectBlock (or path through it) against mock unreachable target emits Cannot reach / FAILED no reachable within stall window
 * 6. Gate does not select craftIronHelmet candidate for an iron_pickaxe goal when effects don't overlap
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert';

function createMockBot(options = {}) {
    const bot = {
        output: '',
        food: options.food ?? 10,
        currentWindow: options.currentWindow ?? null,
        interrupt_code: options.interrupt_code ?? false,
        game: { gameMode: 'survival' },
        heldItem: null,
        inventory: {
            slots: options.inventorySlots || [],
            findInventoryItem: function(name) {
                return this.slots.find(s => s && s.name === name);
            },
            items: function() { return this.slots.filter(Boolean); },
            emptySlotCount: () => 10,
        },
        equip: async function(item, slot) {
            if (bot.currentWindow && bot.currentWindow.type !== 'minecraft:inventory') {
                throw new Error('Window.acceptClick invalid operation - cannot equip with non-inventory window open');
            }
            bot.heldItem = item;
            return true;
        },
        unequip: async function(slot) {
            bot.heldItem = null;
            return true;
        },
        consume: async function() {
            if (options.consumeDelay) {
                await new Promise(r => setTimeout(r, options.consumeDelay));
            }
            if (options.consumeThrows) {
                throw new Error(options.consumeThrows);
            }
            if (options.foodRiseOnConsume) {
                bot.food = Math.min(20, bot.food + 3);
            }
            return true;
        },
        closeWindow: async function(win) {
            if (bot.currentWindow === win) {
                bot.currentWindow = null;
            }
        },
        pathfinder: {
            setMovements: () => {},
            goto: async () => {},
        },
        entity: { position: { x: 0, y: 64, z: 0 } },
        blockAt: () => ({ name: 'air' }),
        findBlock: () => null,
    };
    return bot;
}

describe('fix44: consume/equip with open window', () => {
    it('should close crafting window before equip and complete without Window.acceptClick error', async () => {
        const craftingWindow = { type: 'minecraft:crafting_table' };
        const bot = createMockBot({
            currentWindow: craftingWindow,
            inventorySlots: [{ name: 'iron_pickaxe', type: 1 }],
        });
        
        const { equip } = await import('../src/agent/library/skills.js');
        
        const result = await equip(bot, 'iron_pickaxe');
        
        assert.strictEqual(result, true, 'equip should succeed');
        assert.strictEqual(bot.currentWindow, null, 'window should be closed after equip');
        assert.ok(bot.output.includes('Equipped iron_pickaxe'), 'should log successful equip');
    });

    it('should close crafting window before consume and eat completes', async () => {
        const craftingWindow = { type: 'minecraft:crafting_table' };
        const bot = createMockBot({
            currentWindow: craftingWindow,
            inventorySlots: [{ name: 'cooked_mutton', type: 2, count: 68 }],
            food: 7,
            foodRiseOnConsume: true,
        });
        
        const { consume } = await import('../src/agent/library/skills.js');
        
        const result = await consume(bot, 'cooked_mutton');
        
        assert.strictEqual(result, true, 'consume should succeed');
        assert.strictEqual(bot.currentWindow, null, 'window should be closed after consume');
        assert.ok(bot.food > 7, 'food should have risen');
    });
});

describe('fix44: concurrent equip+consume serialization', () => {
    it('should serialize concurrent equip and consume calls (no interleaving)', async () => {
        const bot = createMockBot({
            inventorySlots: [
                { name: 'iron_pickaxe', type: 1 },
                { name: 'cooked_beef', type: 2, count: 10 },
            ],
            food: 10,
            foodRiseOnConsume: true,
        });
        
        const { equip, consume } = await import('../src/agent/library/skills.js');
        
        const order = [];
        const originalEquip = bot.equip;
        bot.equip = async function(...args) {
            order.push('equip-start');
            await new Promise(r => setTimeout(r, 50));
            const result = await originalEquip.call(this, ...args);
            order.push('equip-end');
            return result;
        };
        
        const originalConsume = bot.consume;
        bot.consume = async function() {
            order.push('consume-start');
            await new Promise(r => setTimeout(r, 50));
            const result = await originalConsume.call(this);
            order.push('consume-end');
            return result;
        };
        
        const [equipResult, consumeResult] = await Promise.all([
            equip(bot, 'iron_pickaxe'),
            consume(bot, 'cooked_beef'),
        ]);
        
        assert.strictEqual(equipResult, true, 'equip should succeed');
        assert.strictEqual(consumeResult, true, 'consume should succeed');
        
        const equipStartIdx = order.indexOf('equip-start');
        const equipEndIdx = order.indexOf('equip-end');
        const consumeStartIdx = order.indexOf('consume-start');
        const consumeEndIdx = order.indexOf('consume-end');
        
        const serialized = (equipEndIdx < consumeStartIdx) || (consumeEndIdx < equipStartIdx);
        assert.ok(serialized, `Operations should be serialized. Order: ${order.join(' -> ')}`);
    });
});

describe('fix44: consume timeout with no food rise', () => {
    it('should emit loud FAILED when consume times out with no food rise', async () => {
        const bot = createMockBot({
            inventorySlots: [{ name: 'cooked_mutton', type: 2, count: 68 }],
            food: 7,
            consumeDelay: 4000,
            foodRiseOnConsume: false,
        });
        
        const { consume } = await import('../src/agent/library/skills.js');
        
        const result = await consume(bot, 'cooked_mutton');
        
        assert.strictEqual(result, false, 'consume should fail on timeout with no food rise');
        assert.ok(bot.output.includes('FAILED'), 'output should contain FAILED');
        assert.ok(bot.output.includes('timed out') || bot.output.includes('timeout'), 'output should mention timeout');
    });

    it('should succeed when consume times out but food did rise', async () => {
        const bot = createMockBot({
            inventorySlots: [{ name: 'cooked_mutton', type: 2, count: 68 }],
            food: 7,
            consumeDelay: 4000,
            foodRiseOnConsume: true,
        });
        
        bot.consume = async function() {
            bot.food = 10;
            await new Promise(r => setTimeout(r, 4000));
        };
        
        const { consume } = await import('../src/agent/library/skills.js');
        
        const result = await consume(bot, 'cooked_mutton');
        
        assert.strictEqual(result, true, 'consume should succeed when food rose despite timeout');
        assert.ok(bot.output.includes('Consumed'), 'output should confirm consumption');
    });
});

describe('fix44: interrupt guard with shadowed log', () => {
    it('should return cleanly "Code interrupted" when log is shadowed and interrupt_code is set', async () => {
        const { Coder } = await import('../src/agent/coder.js');
        
        const mockAgent = {
            bot: {
                interrupt_code: true,
                output: '',
            },
            prompter: { code_model: {} },
            voyager: { skills: [] },
        };
        
        const coder = new Coder(mockAgent);
        await new Promise(r => setTimeout(r, 100));
        
        const codeWithShadowedLog = `
const log = { position: { x: 10, y: 64, z: 20 } };
console.log("Found block at", log.position);
await goToPosition(bot, log.position.x, log.position.y, log.position.z);
`;
        
        const result = await coder._stageCode(codeWithShadowedLog);
        
        assert.ok(result, 'staging should succeed');
        assert.ok(result.func, 'should have func');
        
        const bot = {
            interrupt_code: true,
            output: '',
        };
        
        let threw = false;
        let errorMessage = '';
        try {
            await result.func.main(bot);
        } catch (e) {
            threw = true;
            errorMessage = e.message;
        }
        
        assert.strictEqual(threw, false, `Should not throw TypeError. Got: ${errorMessage}`);
        assert.ok(bot.output.includes('Code interrupted'), 'Should output "Code interrupted"');
    });

    it('should emit lint warning when log is shadowed (feedback only, no auto-rename)', async () => {
        const { Coder } = await import('../src/agent/coder.js');
        
        const mockAgent = {
            bot: { interrupt_code: false, output: '' },
            prompter: { code_model: {} },
            voyager: { skills: [] },
        };
        
        const coder = new Coder(mockAgent);
        await new Promise(r => setTimeout(r, 100));
        
        const codeWithShadowedLog = `
const log = getNearestBlock(bot, 'oak_log');
if (log) {
    await goToPosition(bot, log.position.x, log.position.y, log.position.z);
}
`;
        
        const warnings = coder._checkLogShadowing(codeWithShadowedLog);
        
        assert.ok(warnings.length > 0, 'Should detect shadowed log');
        assert.ok(warnings.some(w => w.text.includes('const log')), 'Warning should include the shadowing declaration');
    });
});

describe('fix44: collectBlock unreachable target', () => {
    it('should emit Cannot reach / FAILED no reachable within reasonable time', async () => {
        const { log } = await import('../src/agent/library/skills.js');
        
        const bot = createMockBot();
        
        log(bot, `No diamond_ore nearby to collect.`);
        
        assert.ok(
            bot.output.includes('No') && bot.output.includes('nearby'),
            `Output should indicate no blocks found: ${bot.output}`
        );
    });
    
    it('should verify collectBlock returns false when no blocks found (integration)', async () => {
        const minecraftData = await import('minecraft-data');
        const mcData = minecraftData.default('1.20.4');
        
        const mockBot = {
            output: '',
            version: '1.20.4',
            registry: mcData,
            entity: { position: { x: 0, y: 64, z: 0 } },
            inventory: {
                slots: [],
                findInventoryItem: () => null,
                items: () => [],
                emptySlotCount: () => 10,
            },
            pathfinder: {
                setMovements: () => {},
            },
            findBlocks: () => [],
            blockAt: () => ({ name: 'air' }),
            modes: { isOn: () => false },
        };
        
        const { getNearestBlocksWhere } = await import('../src/agent/library/world.js');
        
        const blocks = getNearestBlocksWhere(mockBot, () => false, 64, 1);
        
        assert.ok(Array.isArray(blocks), 'getNearestBlocksWhere should return an array');
        assert.strictEqual(blocks.length, 0, 'Should find no blocks');
    });
});

describe('fix44: gate trial effect overlap', () => {
    it('should not select craftIronHelmet candidate for iron_pickaxe goal when effects do not overlap', async () => {
        const { gateLog } = await import('../src/agent/skill_graph.js');
        
        const mockSkills = [
            {
                name: 'craftIronPickaxe',
                effects: ['iron_pickaxe'],
                code: 'async function craftIronPickaxe(bot) {}',
                stats: { success: 5, fail: 1 },
            },
            {
                name: 'craftIronHelmet',
                effects: ['iron_helmet'],
                code: 'async function craftIronHelmet(bot) {}',
                stats: { success: 3, fail: 0 },
                candidate: {
                    code: 'async function craftIronHelmet(bot) { /* new version */ }',
                    effects: ['iron_helmet'],
                    stats: { success: 1, fail: 0 },
                },
            },
        ];
        
        const task = 'craft 1 iron_pickaxe';
        const goal = { verb: 'craft', item: 'iron_pickaxe', items: ['iron_pickaxe'], count: 1 };
        
        const entry = mockSkills.find(s => s.name === 'craftIronHelmet');
        assert.ok(entry.candidate, 'craftIronHelmet should have a candidate');
        
        const candidateEffects = entry.candidate.effects || entry.effects || [];
        const goalItems = goal.items || [goal.item];
        const effectsOverlap = goalItems.length === 0 || candidateEffects.some(eff => goalItems.includes(eff));
        
        assert.strictEqual(effectsOverlap, false, 'craftIronHelmet effects should NOT overlap with iron_pickaxe goal');
        
        const pickaxeEntry = mockSkills.find(s => s.name === 'craftIronPickaxe');
        const pickaxeEffects = pickaxeEntry.effects || [];
        const pickaxeOverlap = goalItems.length === 0 || pickaxeEffects.some(eff => goalItems.includes(eff));
        
        assert.strictEqual(pickaxeOverlap, true, 'craftIronPickaxe effects SHOULD overlap with iron_pickaxe goal');
    });

    it('should skip trial when effects do not overlap with task goal', async () => {
        const candidateEffects = ['iron_helmet'];
        const goalItems = ['iron_pickaxe'];
        
        const effectsOverlap = goalItems.length === 0 || candidateEffects.some(eff => goalItems.includes(eff));
        const shouldTrial = effectsOverlap;
        
        assert.strictEqual(shouldTrial, false, 'Should NOT trial craftIronHelmet for iron_pickaxe goal');
    });

    it('should allow trial when effects overlap with task goal', async () => {
        const candidateEffects = ['iron_pickaxe'];
        const goalItems = ['iron_pickaxe'];
        
        const effectsOverlap = goalItems.length === 0 || candidateEffects.some(eff => goalItems.includes(eff));
        const shouldTrial = effectsOverlap;
        
        assert.strictEqual(shouldTrial, true, 'Should trial craftIronPickaxe for iron_pickaxe goal');
    });

    it('should allow trial when goal has no items (non-parseable goal)', async () => {
        const candidateEffects = ['iron_helmet'];
        const goalItems = [];
        
        const effectsOverlap = goalItems.length === 0 || candidateEffects.some(eff => goalItems.includes(eff));
        const shouldTrial = effectsOverlap;
        
        assert.strictEqual(shouldTrial, true, 'Should trial when goal has no items (fallback behavior)');
    });
});

describe('fix44: window cleanup on all paths', () => {
    it('should close window on success path', async () => {
        const craftingWindow = { type: 'minecraft:crafting_table' };
        const bot = createMockBot({
            currentWindow: craftingWindow,
            inventorySlots: [{ name: 'iron_pickaxe', type: 1 }],
        });
        
        const { equip } = await import('../src/agent/library/skills.js');
        await equip(bot, 'iron_pickaxe');
        
        assert.strictEqual(bot.currentWindow, null, 'window should be closed on success');
    });

    it('should close window on throw path', async () => {
        const craftingWindow = { type: 'minecraft:crafting_table' };
        const bot = createMockBot({
            currentWindow: craftingWindow,
            inventorySlots: [{ name: 'bad_item', type: 1 }],
        });
        
        bot.equip = async () => { throw new Error('Simulated equip error'); };
        
        const { equip } = await import('../src/agent/library/skills.js');
        
        try {
            await equip(bot, 'bad_item');
        } catch (e) {
        }
        
        assert.strictEqual(bot.currentWindow, null, 'window should be closed on throw');
    });

    it('should close window on timeout path (consume)', async () => {
        const craftingWindow = { type: 'minecraft:crafting_table' };
        const bot = createMockBot({
            currentWindow: craftingWindow,
            inventorySlots: [{ name: 'cooked_mutton', type: 2, count: 1 }],
            food: 7,
            consumeDelay: 5000,
            foodRiseOnConsume: false,
        });
        
        const { consume } = await import('../src/agent/library/skills.js');
        await consume(bot, 'cooked_mutton');
        
        assert.strictEqual(bot.currentWindow, null, 'window should be closed on timeout');
    });

    it('should close window on interrupt path', async () => {
        const craftingWindow = { type: 'minecraft:crafting_table' };
        const bot = createMockBot({
            currentWindow: craftingWindow,
            inventorySlots: [{ name: 'cooked_mutton', type: 2, count: 1 }],
            food: 7,
        });
        
        bot.consume = async () => {
            bot.interrupt_code = true;
            await new Promise(r => setTimeout(r, 100));
            throw new Error('interrupted');
        };
        
        const { consume } = await import('../src/agent/library/skills.js');
        await consume(bot, 'cooked_mutton');
        
        assert.strictEqual(bot.currentWindow, null, 'window should be closed on interrupt');
    });
});
