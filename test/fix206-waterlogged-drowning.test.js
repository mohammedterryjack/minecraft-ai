/**
 * fix206 (live icefox2000, 27 Nov 2026): drownings at the shore hotspot -173,4x,10x. The fix120
 * drowning reflex (emergency jump-surfacing at half air, passive jump assist) triggered only when
 * the head block was named 'water'. A head inside a WATERLOGGED block (slab, stairs, fence, pane,
 * wall — minecraft-data 3.x gives exactly these a waterlogged state; probe 27 Nov) still contains
 * water (minecraft.wiki/w/Waterlogging) and drains air (minecraft.wiki/w/Drowning#Air_supplies),
 * so the reflex was dead code there. prismarine-block exposes the flag as block.isWaterlogged
 * (prismarine-block/index.js:197). Kelp is deliberately NOT in this class: its blockstate has no
 * waterlogged property (probe 27 Nov: kelp states = [age], seagrass = []).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import minecraftData from 'minecraft-data';
const { submergedHead } = await import('../src/agent/modes.js');

describe('fix206: waterlogged head cells count as submerged', () => {
    it('waterlogged slabs/stairs/fences/panes/walls are submerged (the drowning class)', () => {
        assert.strictEqual(submergedHead({ name: 'stone_slab', isWaterlogged: true }), true);
        assert.strictEqual(submergedHead({ name: 'stone_stairs', isWaterlogged: true }), true);
        assert.strictEqual(submergedHead({ name: 'oak_fence', isWaterlogged: true }), true);
        assert.strictEqual(submergedHead({ name: 'glass_pane', isWaterlogged: true }), true);
    });
    it('plain water is submerged; air and unloaded cells are not', () => {
        assert.strictEqual(submergedHead({ name: 'water', isWaterlogged: undefined }), true);
        assert.strictEqual(submergedHead({ name: 'air', isWaterlogged: undefined }), false);
        assert.strictEqual(submergedHead(null), false);
        assert.strictEqual(submergedHead(undefined), false);
    });
    it('dry waterloggable blocks (isWaterlogged false) are not submerged', () => {
        assert.strictEqual(submergedHead({ name: 'stone_slab', isWaterlogged: false }), false);
        assert.strictEqual(submergedHead({ name: 'stone' }), false);
    });
    it('the predicate is grounded in real block data: waterloggable classes carry the state, kelp does not', () => {
        const d = minecraftData('1.20.4');
        for (const b of ['stone_slab', 'stone_stairs', 'oak_fence', 'glass_pane', 'cobblestone_wall']) {
            assert.ok((d.blocksByName[b].states ?? []).some(s => s.name === 'waterlogged'), b);
        }
        assert.ok(!(d.blocksByName['kelp'].states ?? []).some(s => s.name === 'waterlogged'));
    });
    it('self_preservation routes BOTH the emergency branch and the surfacing loop through submergedHead', () => {
        const src = readFileSync('src/agent/modes.js', 'utf8');
        assert.match(src, /if \(cellsKnown && submergedHead\(blockAbove\)\)/);
        assert.match(src, /if \(!submergedHead\(head\)\) break;/);
        assert.doesNotMatch(src, /blockAbove\.name === 'water'/);
        assert.doesNotMatch(src, /head\.name !== 'water'/);
    });
});
