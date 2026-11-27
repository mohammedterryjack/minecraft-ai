// fix207: collectBlock must resolve pre-flattening generic family names ("log", "planks", "wool", "leaves") from the
// registry. Vanilla's 1.13 flattening split generic blocks into per-variant blocks (log -> oak_log, birch_log, ...);
// minecraft-data 26.1 has no block named "log" (verified: only *_log / stripped_*_log exist in data/pc/26.1/blocks.json).
// Learned craftPlanks calls collectBlock("log", 1), which threw "log names no block in the game data" 9x on 27 Nov.
// The rule (seeded collectBlock): when blockType itself is not a block, every registry block whose name ends in
// "_"+blockType joins the search set — same registry-driven expansion as the existing coal->coal_ore lines.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Voyager } from '../src/agent/voyager.js';

const prim = () => Voyager.SEEDED_PRIMITIVES.find((p) => p.name === 'collectBlock');

function stage(captures) {
    const getNearestBlocksWhere = () => []; // nothing nearby -> exercise the structured-need (reach) branch
    const findBlocks = () => [];
    const log = () => {};
    const __mcPreconditionUnmet__ = (_bot, o) => {
        captures.precondition = o;
        throw new Error('__mcPreconditionUnmet__');
    };
    const fn = new Function('getNearestBlocksWhere', 'findBlocks', 'log', '__mcPreconditionUnmet__', `return (${prim().code});`)(
        getNearestBlocksWhere,
        findBlocks,
        log,
        __mcPreconditionUnmet__
    );
    const blocksByName = {
        oak_log: { name: 'oak_log', drops: [{ name: 'oak_log' }] },
        birch_log: { name: 'birch_log', drops: [{ name: 'birch_log' }] },
        spruce_planks: { name: 'spruce_planks', drops: [{ name: 'spruce_planks' }] },
        cobblestone: { name: 'cobblestone', drops: [{ name: 'cobblestone' }] },
    };
    const bot = { registry: { blocksByName }, interrupt_code: false };
    return fn(bot, captures.blockType, 1);
}

describe('fix207: collectBlock family-name resolution from the registry', () => {
    it('"log" reaches the *_log family instead of throwing "names no block"', async () => {
        const captures = { blockType: 'log' };
        await assert.rejects(() => stage(captures), /__mcPreconditionUnmet__/);
        assert.ok(captures.precondition, 'a structured reach need must be emitted for the family');
        const need = captures.precondition.need;
        const names = need.anyOf ?? [need.item];
        assert.ok(names.includes('oak_log') && names.includes('birch_log'), `family members must be sources, got ${JSON.stringify(need)}`);
    });
    it('"planks" reaches the *_planks family', async () => {
        const captures = { blockType: 'planks' };
        await assert.rejects(() => stage(captures), /__mcPreconditionUnmet__/);
        const need = captures.precondition.need;
        const names = need.anyOf ?? [need.item];
        assert.ok(names.includes('spruce_planks'), `planks family must resolve, got ${JSON.stringify(need)}`);
    });
    it('a name with no block and no family member still throws the honest bad-name error', async () => {
        const captures = { blockType: 'logg' };
        await assert.rejects(() => stage(captures), /logg names no block in the game data/);
    });
    it('an exact block name is unaffected (cobblestone need names cobblestone)', async () => {
        const captures = { blockType: 'cobblestone' };
        await assert.rejects(() => stage(captures), /__mcPreconditionUnmet__/);
        const need = captures.precondition.need;
        const names = need.anyOf ?? [need.item];
        assert.deepEqual(names, ['cobblestone']);
    });
});
