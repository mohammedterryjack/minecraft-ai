/**
 * fix125 (live iMac 2026-11-16, 11:55 GMT, "Craft 1 iron_helmet"): generated code called the
 * bundled skill as ensureCraftingTable() — no bot — and the skill died inside its own body
 * with "TypeError: Cannot read properties of undefined (reading 'interrupt_code')" at
 * ensureCraftingTable line 66. The message pointed at the wrong place (the skill looked
 * broken, not the call), and the retry loop burned attempts on it. A traced call must state
 * its signature violation where everyone can read it: the trace wrapper already sees the
 * real arguments and the real arity, so it refuses short calls with the fix it wants.
 */
import test from 'node:test';
import assert from 'node:assert';
import { instrumentSrc } from '../src/agent/skill_graph.js';

function mkBot() {
    return {
        output: '',
        quickBarSlot: 0,
        inventory: { slots: [], emptySlotCount: () => 6 },
        entity: { position: { x: 0, y: 0, z: 0, floored: () => ({ offset: () => ({ x: 0, y: 1, z: 0 }) }) } },
        blockAt: () => null,
        health: 20, food: 20, oxygenLevel: 20, game: {},
        interrupt_code: false,
        waitForTicks: async () => {},
    };
}

test('fix125: a traced skill called with fewer args than it declares fails with the signature', async () => {
    const bot = mkBot();
    const src = `
async function ensureCraftingTable(bot) { return true; }
${instrumentSrc(['ensureCraftingTable'])}
return ensureCraftingTable();`;
    const run = new Function('bot', 'getInventoryCounts', src);
    assert.throws(
        () => run(bot, () => ({})),
        /ensureCraftingTable expects 1 argument\(s\), the bot first; called with 0/);
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('fix125: correct calls are untouched (sync and async)', async () => {
    const bot = mkBot();
    const src = `
function syncSkill(bot, n) { return n * 2; }
async function asyncSkill(bot, n = 3) { return n + 1; }
${instrumentSrc(['syncSkill', 'asyncSkill'])}
const a = syncSkill(bot, 21);
const b = await asyncSkill(bot);
return [a, b];`;
    const run = new AsyncFunction('bot', 'getInventoryCounts', src);
    const [a, b] = await run(bot, () => ({}));
    assert.strictEqual(a, 42);
    assert.strictEqual(b, 4);
});
