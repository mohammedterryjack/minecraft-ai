/**
 * fix122: contractToolMismatches must not flag a held item against a block of the SAME name.
 * A block never appears in its own harvestTools, so the pair (tool === block) carries no harvest
 * claim: it is the skill holding/equipping the block itself. Live symptom: the contract backfill
 * for selectCobblestone (post: heldItem === 'cobblestone', and 'cobblestone' is also a block name)
 * failed every attempt ("post expects 'cobblestone' for block 'cobblestone', whose harvestTools
 * are wooden_pickaxe, ...") and retried forever (8 backfill rounds in one log).
 * Pairs that could carry a harvest claim (tool !== block) must still be refused.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
});

describe('fix122: held block vs same-named block is not a harvest claim', () => {
    it('post heldItem === cobblestone with the name cobblestone as a block is accepted', () => {
        const src = "c => c.post.eq.heldItem === 'cobblestone'";
        assert.ok(registry.blocksByName.cobblestone, 'cobblestone is a block in the registry');
        assert.ok(Object.keys(registry.blocksByName.cobblestone.harvestTools).length > 0, 'cobblestone has harvestTools');
        assert.strictEqual(Voyager.contractToolMismatches([src], registry), null);
    });

    it('held cobblestone against a different block still reports the mismatch', () => {
        const src = "c => c.post.eq.heldItem === 'cobblestone' && c.args[0] === 'iron_ore'";
        const msg = Voyager.contractToolMismatches([src], registry);
        assert.match(msg, /post expects 'cobblestone' for block 'iron_ore'/);
    });

    it('the fix84 case (iron_shovel vs iron_ore) is still refused', () => {
        const src = "c => c.post.eq.heldItem === 'iron_shovel' && c.args[0] === 'iron_ore'";
        const msg = Voyager.contractToolMismatches([src], registry);
        assert.match(msg, /post expects 'iron_shovel' for block 'iron_ore'/);
    });
});
