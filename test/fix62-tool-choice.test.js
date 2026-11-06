/**
 * fix62: tool choice = the cheapest inventory tool that works on the block (game data + live inventory), not the strongest.
 * Live root cause: every mine run went collectBlock -> bot.tool.equipForBlock (mineflayer-tool sorts by dig time = top tier)
 * and breakBlockAt -> equipBestTool("pickaxe") (ODYSSEY "equip the strongest" port with a hand tier list), so ~16
 * mineOneIronOre runs wore the only iron_pickaxe out (10:59:22Z: recorded delta -[iron_pickaxe] +[raw_iron]) while a
 * stone_pickaxe that also harvests iron_ore sat in the inventory.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import minecraftData from 'minecraft-data';
import { readFileSync } from 'fs';
import { Voyager } from '../src/agent/voyager.js';
import { equipToolForBlock } from '../src/agent/library/skills.js';
import settings from '../settings.js';

const reg = minecraftData(settings.minecraft_version);
function mockBot(spec, held = null) {
    const items = spec.map(([name, count, durabilityUsed]) => ({ name, type: reg.itemsByName[name].id, count, durabilityUsed }));
    const bot = { registry: reg, output: '', heldItem: held ? items.find(i => i.name === held) : null, wear: {},
        inventory: { items: () => items },
        equip: async (it) => { bot.heldItem = it; },
        unequip: async () => { bot.heldItem = null; } };
    return bot;
}
const block = name => { const b = reg.blocksByName[name]; return { name, material: b.material, harvestTools: b.harvestTools }; };
const pick = async (blockName, inv, held) => { const bot = mockBot(inv, held); const r = await equipToolForBlock(bot, block(blockName)); return { r, bot }; };

describe('fix62: equipToolForBlock picks the cheapest tool that works', () => {
    it('iron_ore with stone + iron + diamond pickaxes -> stone_pickaxe (the live case)', async () => {
        assert.strictEqual((await pick('iron_ore', [['iron_pickaxe', 1, 0], ['stone_pickaxe', 1, 0], ['diamond_pickaxe', 1, 0]])).r, 'stone_pickaxe');
    });
    it('stone with wooden + stone + iron -> wooden_pickaxe; diamond_ore with stone + iron -> iron_pickaxe', async () => {
        assert.strictEqual((await pick('stone', [['iron_pickaxe', 1, 0], ['stone_pickaxe', 1, 0], ['wooden_pickaxe', 1, 0]])).r, 'wooden_pickaxe');
        assert.strictEqual((await pick('diamond_ore', [['iron_pickaxe', 1, 0], ['stone_pickaxe', 1, 0]])).r, 'iron_pickaxe');
    });
    it('nothing in the inventory can harvest obsidian -> null, logged loudly', async () => {
        const { r, bot } = await pick('obsidian', [['iron_pickaxe', 1, 0]]);
        assert.strictEqual(r, null);
        assert.match(bot.output, /FAILED: no inventory tool can harvest obsidian/);
    });
    it('same capability (wooden vs golden pickaxe): scarcity-weighted recipe cost per durability decides -> wooden', async () => {
        assert.strictEqual((await pick('stone', [['golden_pickaxe', 1, 0], ['wooden_pickaxe', 1, 0], ['oak_planks', 20, 0]])).r, 'wooden_pickaxe');
    });
    it('two identical tools: the more worn one is used up first', async () => {
        const { bot } = await pick('iron_ore', [['stone_pickaxe', 1, 3], ['stone_pickaxe', 1, 100]]);
        assert.strictEqual(bot.heldItem.durabilityUsed, 100);
    });
    it('no tool required and none speeds it up: an unrelated held tool is put away (would wear 2 per dig)', async () => {
        const { r, bot } = await pick('oak_log', [['iron_pickaxe', 1, 0]], 'iron_pickaxe');
        assert.strictEqual(r, null);
        assert.strictEqual(bot.heldItem, null);
    });
    it('no tool required, equal capability: scarcity-weighted wear cost decides (dirt shovels follow the inventory)', async () => {
        assert.strictEqual((await pick('dirt', [['iron_shovel', 1, 0], ['wooden_shovel', 1, 0], ['oak_planks', 64, 0], ['stick', 64, 0]])).r, 'wooden_shovel');
        assert.strictEqual((await pick('dirt', [['iron_shovel', 1, 0], ['wooden_shovel', 1, 0], ['iron_ingot', 64, 0], ['stick', 64, 0]])).r, 'iron_shovel');
    });
    it('16 iron_ore digs with iron + stone pickaxes never touch the iron_pickaxe', async () => {
        const bot = mockBot([['iron_pickaxe', 1, 0], ['stone_pickaxe', 1, 0]]);
        for (let i = 0; i < 16; i++) { await equipToolForBlock(bot, block('iron_ore')); bot.heldItem.durabilityUsed++; }
        assert.strictEqual(bot.inventory.items().find(i => i.name === 'iron_pickaxe').durabilityUsed, 0);
        assert.strictEqual(bot.inventory.items().find(i => i.name === 'stone_pickaxe').durabilityUsed, 16);
    });
});

describe('fix62: seeded wiring', () => {
    const P = n => Voyager.SEEDED_PRIMITIVES.find(p => p.name === n);
    it('the seeded equipToolForBlock is the library source itself, with the eq contract', () => {
        assert.strictEqual(P('equipToolForBlock').code, equipToolForBlock.toString());
        assert.strictEqual(P('equipToolForBlock').contract.post, P('equipBestTool').contract.post);
    });
    it('breakBlockAt and collectBlock (seeded and library) choose per block via equipToolForBlock; no mineflayer-tool, no tool-type list', () => {
        for (const n of ['breakBlockAt', 'collectBlock']) {
            assert.ok(P(n).code.includes('await equipToolForBlock(bot, block)'), n);
            assert.ok(!P(n).code.includes('equipForBlock(') && !P(n).code.includes('equipBestTool('), n);
            assert.ok(P(n).deps.includes('equipToolForBlock'), n);
        }
        assert.ok(!P('breakBlockAt').code.includes("['pickaxe', 'axe', 'shovel', 'hoe']"));
        const lib = readFileSync('./src/agent/library/skills.js', 'utf8');
        assert.ok(!lib.includes('await bot.tool.equipForBlock('));
    });
    it('equipBestTool keeps its seeded contract, has no tier list, and ranks from game data', async () => {
        const e = P('equipBestTool');
        assert.strictEqual(e.contract.post, 'c => c.ret === null || (c.post.eq ? c.post.eq.heldItem === c.ret : false)');
        for (const t of ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']) assert.ok(!e.code.includes(`'${t}'`), `no tier literal ${t}`);
        const log = () => {}; void log;
        const equipBestTool = eval('(' + e.code + ')');
        const best = async (inv, type) => equipBestTool(mockBot(inv), type);
        assert.strictEqual(await best([['stone_pickaxe', 1, 0], ['iron_pickaxe', 1, 0], ['wooden_pickaxe', 1, 0]], 'pickaxe'), 'iron_pickaxe');
        assert.strictEqual(await best([['diamond_pickaxe', 1, 0], ['netherite_pickaxe', 1, 0]], 'pickaxe'), 'netherite_pickaxe');
        assert.strictEqual(await best([['golden_pickaxe', 1, 0], ['stone_pickaxe', 1, 0]], 'pickaxe'), 'stone_pickaxe');
        assert.strictEqual(await best([['stone_sword', 1, 0], ['diamond_sword', 1, 0]], 'sword'), 'diamond_sword');
        assert.strictEqual(await best([['oak_log', 1, 0]], 'pickaxe'), null);
    });
});
