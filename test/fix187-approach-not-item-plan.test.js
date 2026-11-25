// fix187: "approach cod" must not be decomposed into its item producer "Kill 1 cod".
// parseVerboseGoal's fix51 camelCase fallback parses "approach cod" as an item goal
// (cod, count 1), so the game-data branch of _decompose planned cod's producer
// ("Kill 1 cod") as its subgoal. Killing cod requires approaching cod, and the fix87
// needs path decomposes "Kill 1 cod" back into "approach cod" — the two goals
// decomposed into each other every cycle (live 25 Nov: approach cod -> Kill 1 cod ->
// approach cod repeated while the bot starved at food 1/20). The goal KIND resolved by
// _resolveGoal is authoritative: game-data item planning is for item goals only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Voyager } from '../src/agent/voyager.js';
import { _setVersionForTest as loadMcData } from '../src/utils/mcdata.js';
import minecraftData from 'minecraft-data';

function fixture() {
    loadMcData('1.20.4');
    const v = Object.create(Voyager.prototype);
    v.agent = { bot: { registry: minecraftData('pc', '1.20.4') } };
    v.progress = { decomposed: {}, subgoals: [], failed: [], completedAt: {} };
    v._saveProgress = () => {};
    v._curSub = null;
    v.skills = [];
    v.retrieveSkills = async () => [];
    v._askLocal = async () => JSON.stringify({ subgoals: ['Travel to the nearest ocean biome', 'Walk along the nearest shoreline'] });
    v._inferMeta = () => ({});
    v._stateText = () => 'state';
    v._deathHotspots = () => '';
    v.observe = () => ({ nearby_blocks: [], inventory: {} });
    // Entering the game-data item branch would need a planner and the producer graph;
    // both explode if touched, proving the approach goal never enters item planning.
    v._obtainPlanner = () => {
        throw new Error('fix187: approach goal must not enter game-data item planning');
    };
    v._producers = () => {
        throw new Error('fix187: approach goal must not consult the producer graph');
    };
    return v;
}

test('fix187: "approach cod" never gets its item producer "Kill 1 cod" as a subgoal', async () => {
    const v = fixture();
    assert.strictEqual(v._resolveGoal('approach cod').kind, 'approach');
    const ok = await v._decompose('approach cod', 'approachCod() returned false: no cod within 48 blocks');
    assert.strictEqual(ok, true);   // LLM decomposition path, not the producer plan
    const queued = v.progress.subgoals.map(s => s.task);
    assert.ok(!queued.some(t => /kill/i.test(t)), `no kill-producer subgoal, got: ${queued.join(', ')}`);
});

test('fix187: a real item goal keeps a non-approach kind (guard is approach-kind only)', () => {
    const v = fixture();
    assert.notStrictEqual(v._resolveGoal('Collect 1 cobblestone').kind, 'approach');
    assert.notStrictEqual(v._resolveGoal('Kill 1 cod').kind, 'approach');
});
