/**
 * fix151: swimTowards must dig through what stops it. A sealed pool or capped column only opens
 * by removing a block; any diggable block opens by hand (fix150 rule; mineflayer gates digging on
 * block.diggable + reach — node_modules/mineflayer/lib/plugins/digging.js canDigBlock; prismarine-block
 * canHarvest predicts drops only). Live 20 Nov: bot pinned in the pool at (-173,44,103), 34
 * "could not swim to dry ground ... two game seconds without entering a new cell" failures in
 * minutes, food 20 -> 4, because the swimmer returned blocked instead of digging the wall.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Vec3 } from 'vec3';
import { swimTowards } from '../src/agent/library/skills.js';

const solid = (name, diggable) => ({ name, diggable, canHarvest: () => null });

function makeSwimmer(blocks, escapeAfterDig) {
    const dug = [];
    const bot = {
        output: '',
        food: 20,
        health: 20,
        interrupt_code: false,
        entity: { position: new Vec3(-173.5, 44.5, 103.5), isInWater: true, eyeHeight: 1.62 },
        setControlState: () => {},
        lookAt: async () => {},
        waitForTicks: async () => {
            await new Promise(r => setTimeout(r, 1));
        },
        blockAt: (pos) => blocks[`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`] ?? null,
        dig: async (b) => {
            dug.push(`${b.name}`);
            if (escapeAfterDig) bot.entity.isInWater = false; // wall opened, bot swims out
        },
        dug,
    };
    return bot;
}

describe('fix151: blocked swim digs the wall', () => {
    it('digs the cobblestone wall between the bot and the target column and escapes', async () => {
        // target (-176,45,106) from (-173.5,44.5,103.5): sx=-1, sz=+1 -> primary candidate (-174,44,104)
        const blocks = { '-174,44,104': solid('cobblestone', true) };
        const bot = makeSwimmer(blocks, true);
        const swim = await swimTowards(bot, -176, 106);
        assert.equal(swim.reached, true, `log:\n${bot.output}`);
        assert.deepEqual(bot.dug, ['cobblestone']);
        assert.match(bot.output, /digging cobblestone at -174,44,104/);
    });

    it('reports blocked only when every candidate is undiggable (bedrock shell)', async () => {
        const bed = () => solid('bedrock', false);
        const blocks = {};
        for (const k of ['-174,44,104', '-174,45,104', '-174,44,103', '-174,45,103', '-173,44,104', '-173,45,104',
            '-173,45,103', '-173,46,103', '-173,47,103']) blocks[k] = bed();
        const bot = makeSwimmer(blocks, false);
        const swim = await swimTowards(bot, -176, 106);
        assert.equal(swim.reached, false);
        assert.equal(swim.blocked, true);
        assert.deepEqual(bot.dug, []);
        assert.match(bot.output, /undiggable bedrock/);
    });

    it('each walled cell is dug at most once per swim (no dig loop on one spot)', async () => {
        let escapes = 0;
        const blocks = { '-174,44,104': solid('stone', true) };
        const bot = makeSwimmer(blocks, false);
        bot.dig = async (b) => {
            bot.dug.push(b.name);
            bot.entity.isInWater = (++escapes >= 1) ? false : true;
        };
        const swim = await swimTowards(bot, -176, 106);
        assert.equal(swim.reached, true);
        assert.equal(bot.dug.length, 1);
    });
});
