/**
 * fix150: Block.canHarvest predicts DROPS, not breakability (prismarine-block: false only when the
 * block lists harvestTools the held item lacks; the game still breaks any diggable block by hand —
 * stone 7.5s, cobblestone 10s — with no drop; bedrock is diggable=false). mineflayer permits digging
 * exactly when canDigBlock: block.diggable && within reach (node_modules/mineflayer/lib/plugins/digging.js
 * canDigBlock). The old canHarvest-as-breakability gate refused hand-digs and entombed the bot in its
 * own hole ("Pathfinding stopped: Cannot break cobblestone with current tools", "Don't have right
 * tools to break cobblestone", 15x + 679x live on 20 Nov).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Vec3 } from 'vec3';
import { breakBlockAt } from '../src/agent/library/skills.js';

const here = dirname(fileURLToPath(import.meta.url));

function makeBot() {
    // fix156: the refusal branch of equipToolForBlock reads bot.registry to name the required
    // tools, so this mock carries a minimal cobblestone-shaped registry (ids match cobble below)
    const picks = { 257: { id: 257, name: 'wooden_pickaxe' }, 258: { id: 258, name: 'golden_pickaxe' }, 270: { id: 270, name: 'stone_pickaxe' }, 274: { id: 274, name: 'iron_pickaxe' }, 278: { id: 278, name: 'diamond_pickaxe' }, 282: { id: 282, name: 'netherite_pickaxe' }, 286: { id: 286, name: 'netherite_pickaxe' } };
    const speeds = { 257: 2, 258: 3, 270: 4, 274: 6, 278: 8, 282: 9, 286: 9 };
    return {
        output: '',
        food: 20,
        health: 20,
        game: { gameMode: 'survival' },
        modes: { isOn: () => false },
        entity: { position: new Vec3(-174.5, 47, 109.5), eyeHeight: 1.62 },
        inventory: { items: () => [] }, // no tools at all: the entombed state
        heldItem: null,
        registry: { items: picks, materials: { 'mineable/pickaxe': speeds }, blocksArray: [] },
        unequip: async () => {},
        equip: async () => {},
        dug: [],
        dig: async (block) => { bot_dug(block); },
        chat: () => {},
    };
}
let currentBot = null;
function bot_dug(block) { currentBot.dug.push(block.name); }

const cobble = {
    name: 'cobblestone',
    diggable: true,
    material: 'mineable/pickaxe',
    harvestTools: { 270: true, 274: true, 278: true, 282: true, 286: true, 257: true, 258: true }, // any pickaxe
    canHarvest: () => null, // hand: no drops — verified against prismarine-block (probe, 26.1)
    position: new Vec3(-174, 48, 109), // block directly above the bot's feet: the escape dig
};
const bedrock = {
    name: 'bedrock',
    diggable: false,
    material: 'default',
    harvestTools: undefined,
    canHarvest: () => null,
    position: new Vec3(-174, 46, 109),
};

describe('fix150: hand-dig is legal for diggable blocks', () => {
    it('breakBlockAt digs cobblestone by hand and reports it will not drop', async () => {
        const bot = makeBot();
        currentBot = bot;
        bot.blockAt = () => cobble;
        const ok = await breakBlockAt(bot, -174, 48, 109);
        assert.equal(ok, true, `expected hand-dig success, log:\n${bot.output}`);
        assert.deepEqual(bot.dug, ['cobblestone']);
        assert.match(bot.output, /No harvest tool for cobblestone/);
        assert.doesNotMatch(bot.output, /Don't have right tools/);
    });

    it('breakBlockAt still refuses genuinely undiggable blocks (bedrock)', async () => {
        const bot = makeBot();
        currentBot = bot;
        bot.blockAt = () => bedrock;
        const ok = await breakBlockAt(bot, -174, 46, 109);
        assert.equal(ok, false);
        assert.deepEqual(bot.dug, []);
        assert.match(bot.output, /not diggable/);
    });
});

describe('fix150: seeded breakBlockAt template carries the same rule', () => {
    const src = readFileSync(join(here, '..', 'src', 'agent', 'voyager.js'), 'utf8');
    const m = src.match(/name: 'breakBlockAt',[\s\S]*?code: `([\s\S]*?)`,\n/);

    it('template renders to valid JS', () => {
        assert.ok(m, 'seeded breakBlockAt template not found in voyager.js');
        const body = eval('`' + m[1] + '`'); // evaluate escapes the same way the module does
        new Function('log', 'Vec3', 'equipToolForBlock', 'goToPosition', 'withinInteractionRange', body);
    });

    it('template gates on diggable, not on canHarvest', () => {
        const body = eval('`' + m[1] + '`');
        assert.match(body, /if \(!block\.diggable\)/);
        assert.doesNotMatch(body, /Don't have right tools/);
        // canHarvest only warns (drops), never returns false
        const ch = body.match(/if \(!block\.canHarvest\(itemId\)\)[^\n]*/);
        assert.ok(ch, 'canHarvest check missing');
        assert.doesNotMatch(ch[0], /return false/);
    });
});
