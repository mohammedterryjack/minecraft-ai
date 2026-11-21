/**
 * fix157: mineflayer's bot.dig rejects with a bare Error('Digging aborted') whenever
 * bot.stopDigging() fires (node_modules/mineflayer/lib/plugins/digging.js:165-189) — a mode
 * pre-empted the task, a new dig request or a pathfinder takeover. breakBlock promises a
 * boolean, but the exception escaped to the code model as "Error: Digging aborted" with no
 * cause ("!!Code threw exception!!" live 21 Nov, after "No harvest tool for stone: breaking
 * by hand"). Both the library breakBlock and the seeded breakBlockAt template now convert an
 * aborted dig to FAILED + false, naming the cause (precedent: "navigation cancelled
 * (interrupted)" in gotoWithProgress).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Vec3 } from 'vec3';
import { breakBlockAt } from '../src/agent/library/skills.js';

const here = dirname(fileURLToPath(import.meta.url));

const cobble = {
    name: 'cobblestone',
    diggable: true,
    material: 'mineable/pickaxe',
    harvestTools: { 458: true },
    canHarvest: () => null,
    position: new Vec3(-145, 63, 97),
};

function makeBot(digBehavior) {
    const picks = { 458: { id: 458, name: 'wooden_pickaxe' } };
    return {
        output: '',
        food: 20,
        health: 20,
        interrupt_code: false,
        game: { gameMode: 'survival' },
        modes: { isOn: () => false },
        entity: { position: new Vec3(-145.5, 63, 97.5), eyeHeight: 1.62 },
        inventory: { items: () => [] },
        heldItem: null,
        registry: { items: picks, materials: { 'mineable/pickaxe': { 458: 2 } }, blocksArray: [] },
        unequip: async () => {},
        equip: async () => {},
        dig: digBehavior,
        blockAt: () => cobble,
        chat: () => {},
        pathfinder: { setMovements: () => {}, stop: () => {} },
    };
}

describe('fix157: aborted digs become FAILED + false, not escaping exceptions', () => {
    it('breakBlockAt returns false and names the takeover when the dig is aborted', async () => {
        const bot = makeBot(async () => { throw new Error('Digging aborted'); });
        const ok = await breakBlockAt(bot, -145, 63, 97);
        assert.strictEqual(ok, false, `expected false, log:\n${bot.output}`);
        assert.match(bot.output, /FAILED: dig of cobblestone at .*cancelled \(another dig or pathfinder action took over\)/);
    });
    it('names interruption as the cause when interrupt_code is set', async () => {
        const bot = makeBot(async () => { throw new Error('Digging aborted'); });
        bot.interrupt_code = true;
        const ok = await breakBlockAt(bot, -145, 63, 97);
        assert.strictEqual(ok, false);
        assert.match(bot.output, /cancelled \(interrupted by a mode or new command\)/);
    });
    it('non-abort dig errors still propagate (fail loud)', async () => {
        const bot = makeBot(async () => { throw new Error('Digging failed: not enough durability'); });
        await assert.rejects(() => breakBlockAt(bot, -145, 63, 97), /durability/);
    });
});

describe('fix157: seeded breakBlockAt template carries the same rule', () => {
    const src = readFileSync(join(here, '..', 'src', 'agent', 'voyager.js'), 'utf8');
    const m = src.match(/name: 'breakBlockAt',[\s\S]*?code: `([\s\S]*?)`,\n/);

    it('template renders to valid JS with an aborted-dig catch', () => {
        assert.ok(m, 'seeded breakBlockAt template not found in voyager.js');
        const body = eval('`' + m[1] + '`');
        new Function('log', 'Vec3', 'equipToolForBlock', 'goToPosition', 'withinInteractionRange', body);
        assert.match(body, /aborted\/i\.test\(digErr\?\.message/);
        assert.match(body, /return false;\s*\}\s*\n\s*log\(bot, `Broke /);
    });
});
