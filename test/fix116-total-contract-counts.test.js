/**
 * fix116: contract item counts are total — an unheld item reads 0, not undefined.
 * The learned craftRecipe post `c => c.ret === false || c.ret === null || (c.args[0] !== null
 *   && c.post.inv[c.args[0]] > c.pre.inv[c.args[0]])`
 * judged a successful craft (delta +1 iron_leggings, item absent from pre.inv) as VIOLATED
 * because `1 > undefined === false` (live 2026-11-15).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

let Voyager;
before(async () => { Voyager = (await import('../src/agent/voyager.js')).Voyager; });

function mk() {
    const v = Object.create(Voyager.prototype);
    v._contractGame = () => ({ item: () => true, block: () => true, drops: () => [], harvestTools: () => null });
    return v;
}

const st = (inv, extra = {}) => ({ pos: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, oxygen: 15, sky: 15, alive: true, dim: 'overworld', inv, free: 5, eq: {}, ...extra });

describe('fix116 total contract counts', () => {
    it('a gained item with no pre.inv key satisfies the post', () => {
        const v = mk();
        const ctx = v._contractCtx({
            args: ['iron_leggings', 1],
            ret: true,
            pre: st({ iron_ingot: 7 }),
            post: st({ iron_ingot: 0, iron_leggings: 1 }),
            delta: { iron_ingot: -7, iron_leggings: 1 },
        });
        assert.strictEqual(ctx.pre.inv.iron_leggings, 0);
        assert.strictEqual(ctx.post.inv.iron_leggings, 1);
        // The learned post verbatim (as a literal; the runtime compiles it in an SES compartment).
        const post = (c) => c.ret === false || c.ret === null || (c.args[0] !== null && c.post.inv[c.args[0]] > c.pre.inv[c.args[0]]);
        assert.strictEqual(post(ctx), true);
    });

    it('existing keys keep their values and identity of the source object is untouched', () => {
        const v = mk();
        const src = { cobblestone: 64 };
        const ctx = v._contractCtx({ args: [], ret: true, pre: st(src), post: st(src), delta: {} });
        assert.strictEqual(ctx.pre.inv.cobblestone, 64);
        assert.strictEqual(ctx.pre.inv.granite, 0);
        assert.strictEqual(src.granite, undefined); // original snapshot not mutated
        assert.strictEqual(Object.hasOwn(src, 'cobblestone'), true);
    });

    it("'in' and Object.keys keep their meaning", () => {
        const v = mk();
        const ctx = v._contractCtx({ args: [], ret: true, pre: st({ coal: 3 }), post: st({ coal: 3 }), delta: {} });
        assert.strictEqual('coal' in ctx.pre.inv, true);
        assert.strictEqual('dirt' in ctx.pre.inv, false);
        assert.deepStrictEqual(Object.keys(ctx.pre.inv), ['coal']);
    });

    it('c.delta reads 0 for an item that did not move', () => {
        const v = mk();
        const ctx = v._contractCtx({ args: [], ret: true, pre: st({}), post: st({}), delta: { iron_ingot: -7 } });
        assert.strictEqual(ctx.delta.iron_ingot, -7);
        assert.strictEqual(ctx.delta.cobblestone, 0);
    });
});
