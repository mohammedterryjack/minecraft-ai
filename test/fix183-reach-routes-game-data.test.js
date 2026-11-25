/**
 * fix183 (live icefox2000, 24 Nov 2026, ~20:19-20:47 GMT):
 *   new task: Collect 1 iron_block -> the block does not exist in this world -> the collect reports a reach need
 *   -> "reach iron_block" chained and burned 4 full attempts re-searching a world the search already refuted,
 *   and only after the failure did the re-chain produce "Craft 1 iron_block" (9 iron_ingots held) — the route the
 *   game-data planner states from the start. A reach need is EVIDENCE OF ABSENCE: chaining the search again is
 *   repeating refuted exploration. Voyager's automatic curriculum proposes the next frontier task from the skill
 *   library and world state instead (arXiv:2305.16291, Wang et al. 2023).
 * The fix: _subgoalForNeed asks the same obtain planner the rest of the chain uses (its unknown cost charges
 * collect routes with no perceived source, so the refuted search only wins when nothing else is cheaper). Best
 * route craft/smelt/obtain -> that task is the subgoal; best route still collect (a source is perceived or the
 * obtain is proven), or no route at all in the data (oak_log with no tree perceived) -> reach stays, which is
 * the old behaviour.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);
const { Recipe } = require('prismarine-recipe')(registry);

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
});

function mk() {
    const v = Object.create(Voyager.prototype);
    v.skills = [];
    v.mobSightings = new Map();
    v.progress = { recipeEdges: {}, completed: [], goalStats: {}, blockers: [] };
    v.agent = { bot: { version: VER, registry, recipesAll: (id) => Recipe.find(id) }, chat_logs: [] };
    return v;
}

// a state with nothing perceived: present(block) is false for every block
function blindState(inventory) {
    return { inventory, nearby_blocks: [], perceived_at: {} };
}

const quiet = f => { const o = console.log; console.log = () => {}; try { return f(); } finally { console.log = o; } };

describe('fix183: a reach need consults the game data before chaining the refuted search', () => {
    it('live replay 20:19 GMT: reach iron_block with 9 iron_ingots held chains "Craft 1 iron_block", not "reach iron_block"', () => {
        const v = mk();
        const state = blindState({ iron_ingot: 9, cobblestone: 100, stone_pickaxe: 1 });
        const sub = quiet(() => v._subgoalForNeed({ item: 'iron_block', count: 1, reason: 'reach' }, state, 'Collect 1 iron_block', []));
        assert.strictEqual(sub.task, 'Craft 1 iron_block');
        assert.strictEqual(sub.edge, 'iron_block', 'a game-data route carries the edge its success proves');
    });
    it('reach iron_block with 5 ingots + raw iron + furnace + fuel chains the game-data route (smelt feeds the craft)', () => {
        const v = mk();
        const state = blindState({ iron_ingot: 5, raw_iron: 10, furnace: 1, coal: 4, stone_pickaxe: 1 });
        const sub = quiet(() => v._subgoalForNeed({ item: 'iron_block', count: 1, reason: 'reach' }, state, 'Collect 1 iron_block', []));
        assert.strictEqual(sub.task, 'Craft 1 iron_block', 'the planner chains craft; its ingredient need chains the smelt');
    });
    it('no game-data route at all (oak_log, nothing perceived): reach stays — searching is the only option', () => {
        const v = mk();
        const state = blindState({ cobblestone: 64, stone_pickaxe: 1 });
        const sub = quiet(() => v._subgoalForNeed({ item: 'oak_log', count: 1, reason: 'reach' }, state, 'Craft 1 oak_planks', []));
        assert.strictEqual(sub.task, 'reach oak_log');
        assert.strictEqual(sub.edge, null);
    });
    it('a perceived, reachable source keeps the reach task (the planner still says collect)', () => {
        const v = mk();
        const state = blindState({ cobblestone: 64, iron_pickaxe: 1 });
        state.perceived_at = { iron_block: { x: 3, y: 70, z: 4 } };
        state.nearby_blocks = ['iron_block'];
        state._reach = { iron_block: 'success' };   // already searched and reachable, no pathfinder needed
        const sub = quiet(() => v._subgoalForNeed({ item: 'iron_block', count: 1, reason: 'reach' }, state, 'Collect 1 iron_block', []));
        assert.strictEqual(sub.task, 'reach iron_block', 'a source the world shows keeps the search task');
    });
    it('a fix97 unsearchedBlock error propagates to the caller search loop instead of chaining reach', () => {
        const v = mk();
        // perceived but never searched: the reach search is still partial, so reachableBlock throws
        // err.unsearchedBlock and the reach chain must NOT swallow it
        v.agent.bot.entity = { position: { x: 0, y: 70, z: 0 }, eyeHeight: 1.62 };
        v.agent.bot.world = {};
        v.agent.bot.game = { gameMode: 'survival' };
        v.agent.bot.pathfinder = {
            movements: {}, tickTimeout: 50, thinkTimeout: 5000,
            // * generator still mid-search: pathToBlockReady returns null (partial)
            * getPathFromTo() { yield { result: { status: 'partial' } }; },
        };
        const state = blindState({ cobblestone: 64, iron_pickaxe: 1 });
        state.perceived_at = { iron_block: { x: 40, y: 70, z: 40 } };
        state.nearby_blocks = ['iron_block'];
        assert.throws(() => quiet(() => v._subgoalForNeed({ item: 'iron_block', count: 1, reason: 'reach' }, state, 'Collect 1 iron_block', [])),
            (err) => err.unsearchedBlock === 'iron_block',
            'the search loop error must surface; reach must not silently chain');
    });
    it('the no-acyclic-way throw carries the structured flag the reach chain reads', async () => {
        const { obtainPlanner } = await import('../src/agent/recipe_plan.js');
        const planner = obtainPlanner({
            registry, recipesOf: (id) => Recipe.find(id),
            known: () => false, proven: () => false, edgeSuccess: () => 0.5,
            smeltInputs: () => [], present: () => false, mobSighted: () => false,
        });
        try {
            // command_block: no recipe, no mob drop, no source block, and the survival craft chain is cyclic —
            // the one item class the game data cannot route to at all
            planner.prerequisites('command_block', 1, {});
            assert.fail('expected the no-way throw');
        } catch (err) {
            assert.strictEqual(err.noAcyclicWay, true);
        }
    });
});
