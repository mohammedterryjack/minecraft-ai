/**
 * fix91b (live icefox2000, 10:26 GMT 7 Nov, d862c09): an anyOf need was stored as
 * { item: undefined, count, reason, task, at }. JSON dropped item, and the next boot threw
 * "progress.blockers entry is not a structured need { item, count, reason, task }" so init_agent exited 1.
 * The live row was {"count":1,"reason":"reach","task":"Collect 1 wheat_seeds","at":1794046192920}.
 *
 * A blocker stores item XOR anyOf (anyOf copied from the need). Boot accepts either and rejects neither.
 * An anyOf blocker clears when one member is held at >= count (cheapest plans that many of one item, not the sum).
 * The curriculum line says "one of a, b, c".
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);
const { Recipe } = require('prismarine-recipe')(registry);

let Voyager;
let assertProgressBlocker;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    assertProgressBlocker = mod.assertProgressBlocker;
    mod._setVersionForTest(VER);
});

const SOURCES = ['oak_log', 'birch_log'];
const REACH = { anyOf: SOURCES, count: 1, reason: 'reach', source: 'no source block in range' };

function mkV() {
    const v = Object.create(Voyager.prototype);
    v.agent = {
        bot: { version: VER, registry, recipesAll: (id) => Recipe.find(id), inventory: { emptySlotCount: () => 36 } },
        openChat() {},
        fatal() {},
    };
    v.skills = [];
    v.npGraph = null;
    v.progress = { subgoals: [], decomposed: {}, failed: [], completedAt: {}, completed: [], blockers: [], recipeEdges: {}, goalStats: {} };
    v._saveProgress = () => {};
    v._curSub = null;
    return v;
}

function state(inv = {}) {
    return { inventory: inv, nearby_blocks: [] };
}

describe('fix91b: recording an anyOf need keeps anyOf through JSON', () => {
    it('the reach anyOf on "Collect 1 wheat_seeds" is stored and round-trips', () => {
        const v = mkV();
        assert.strictEqual(v._chainNeeds('Collect 1 wheat_seeds', [REACH], state()), true);
        const [row] = v.progress.blockers;
        assert.deepStrictEqual(row.anyOf, SOURCES);
        assert.strictEqual(Object.hasOwn(row, 'item'), false);
        assert.strictEqual(row.count, 1);
        assert.strictEqual(row.reason, 'reach');
        assert.strictEqual(row.task, 'Collect 1 wheat_seeds');
        const back = JSON.parse(JSON.stringify(v.progress.blockers));
        assert.deepStrictEqual(back[0].anyOf, SOURCES);
        assert.strictEqual(Object.hasOwn(back[0], 'item'), false);
        assert.doesNotThrow(() => assertProgressBlocker(back[0]));
    });

    it('a need with neither item nor anyOf is not written', () => {
        const v = mkV();
        assert.throws(
            () => v._chainNeeds('Collect 1 wheat_seeds', [{ count: 1, reason: 'reach', source: 'x' }], state()),
            /exactly one of item \/ anyOf/,
        );
        assert.deepStrictEqual(v.progress.blockers, []);
    });
});

describe('fix91b: boot validator accepts item XOR anyOf', () => {
    const names = ['fix91b-item', 'fix91b-any', 'fix91b-neither', 'fix91b-both'];
    const booted = [];
    after(() => {
        for (const v of booted) if (v._saveTimer) clearTimeout(v._saveTimer);
        for (const name of names) rmSync(join(ROOT, 'bots', name), { recursive: true, force: true });
    });

    function boot(name, blockers) {
        const dir = join(ROOT, 'bots', name, 'skills');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'progress.json'), JSON.stringify({ completedAt: {}, completed: [], failed: [], blockers }));
        const v = new Voyager({
            name,
            fatal() {},
            bot: { version: VER, chat() {}, on() {}, off() {}, once() {}, removeListener() {}, inventory: { emptySlotCount: () => 36 } },
        });
        booted.push(v);
        return v;
    }

    it('item-only and anyOf-only load; neither throws the structured-need error', () => {
        const itemOnly = boot('fix91b-item', [{ item: 'oak_log', count: 1, reason: 'ingredients', task: 'Craft 4 oak_planks' }]);
        assert.strictEqual(itemOnly.progress.blockers[0].item, 'oak_log');
        const anyOnly = boot('fix91b-any', [{ anyOf: SOURCES, count: 1, reason: 'reach', task: 'Collect 1 wheat_seeds', at: 1794046192920 }]);
        assert.deepStrictEqual(anyOnly.progress.blockers[0].anyOf, SOURCES);
        assert.throws(
            () => boot('fix91b-neither', [{ count: 1, reason: 'reach', task: 'Collect 1 wheat_seeds', at: 1794046192920 }]),
            /progress\.blockers entry is not a structured need \{ item \| anyOf, count, reason, task \}/,
        );
        assert.throws(
            () => boot('fix91b-both', [{ item: 'oak_log', anyOf: SOURCES, count: 1, reason: 'reach', task: 'Collect 1 wheat_seeds' }]),
            /progress\.blockers entry is not a structured need \{ item \| anyOf, count, reason, task \}/,
        );
    });
});

describe('fix91b: an anyOf blocker clears when one member is held, and the prompt names it', () => {
    it('one member at the count resolves it; a split across members does not', () => {
        const v = mkV();
        v.progress.blockers = [{ anyOf: SOURCES, count: 2, reason: 'reach', task: 'Collect 1 wheat_seeds', at: 1 }];
        v.progress.subgoals = [{ task: 'Collect 1 wheat_seeds', retry: true }];   // fix96: the goal is still open
        const stayed = v._blockerHint({ oak_log: 1, birch_log: 1 });
        assert.strictEqual(v.progress.blockers.length, 1);
        assert.match(stayed, /one of oak_log, birch_log/);
        assert.equal(stayed.includes('undefined'), false);
        const cleared = v._blockerHint({ birch_log: 2 });
        assert.strictEqual(cleared, '');
        assert.deepStrictEqual(v.progress.blockers, []);
    });

    it('the curriculum line has no undefined item', () => {
        const v = mkV();
        v.progress.blockers = [{ anyOf: SOURCES, count: 1, reason: 'reach', task: 'Collect 1 wheat_seeds', at: 1794046192920 }];
        v.progress.subgoals = [{ task: 'Collect 1 wheat_seeds', retry: true }];   // fix96: the goal is still open
        const line = v._blockerHint({});
        assert.strictEqual(line, '\nBLOCKERS (prioritize these - what failed goals lack): "Collect 1 wheat_seeds" needs 1 one of oak_log, birch_log (reach)');
        assert.equal(line.includes('undefined'), false);
    });
});
