/**
 * fix143: pickupNearbyItems returns true only if an item was actually picked up.
 * The docstring says "true if the items were picked up". With nothing nearby the loop never ran and
 * the function returned a vacuous true, which violated the learned postcondition
 * ret === true ⇒ (free slots shrank || inventory gained) on every mineBlocks call whose drops the
 * game had already auto-collected (live 18 Nov: mineOre > mineBlocks > pickupNearbyItems,
 * ~27 POSTCONDITION violations in one run window, each queueing a repair of a skill whose code
 * cannot fix the claim). The seeded codegen template taught the model the same vacuous true.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.20.4');

describe('fix143 pickupNearbyItems honest return', () => {
    it('returns false when nothing is nearby (was a vacuous true)', async () => {
        const { pickupNearbyItems } = await import('../src/agent/library/skills.js');
        const bot = {
            output: '',
            interrupt_code: false,
            version: '1.20.4',
            nearestEntity: () => undefined,
            entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 2 } },
            pathfinder: { setMovements() {}, stop() {} },
            inventory: { slots: new Array(46).fill(null), inventoryStart: 9, inventoryEnd: 45, items() { return []; } },
            on() {}, removeListener() {},
            game: { gameMode: 'survival' }, modes: { isOn: () => false },
        };
        assert.strictEqual(await pickupNearbyItems(bot), false);
        assert.match(bot.output, /Picked up 0 items/);
    });

    it('the library returns pickedUp > 0, not a vacuous true', () => {
        const src = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
        const start = src.indexOf('export async function pickupNearbyItems');
        const end = src.indexOf('export async function breakBlockAt', start);
        const body = src.slice(start, end);
        assert.match(body, /return pickedUp > 0;/);
        assert.doesNotMatch(body, /Picked up \$\{pickedUp\} items\.`\);\s*\n\s*return true;/);
    });

    it('the seeded codegen template returns pickedUp > 0, not a vacuous true', () => {
        const src = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
        const start = src.indexOf("name: 'pickupNearbyItems'");
        assert.ok(start > 0);
        const end = src.indexOf('deps: [],', start);
        const tpl = src.slice(start, end);
        assert.match(tpl, /return pickedUp > 0;/);
        assert.doesNotMatch(tpl, /return true;\s*\}\s*`/);
    });

    void registry;
});
