// fix176: decomposition is bounded per goal. The PSN retry loop re-proposed "Kill 1 salmon"
// after every failure for hours (live 23 Nov 2026: 8+ full failure cycles, drownings during the
// fish chase, food 20/20 throughout). Voyager records failures and lets the curriculum move on;
// here each goal gets MAX_GOAL_DECOMPOSES (2) decompositions since its last success, then is
// abandoned loudly and left to goalFailStates backoff.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Voyager } from '../src/agent/voyager.js';
import { _setVersionForTest as loadMcData } from '../src/utils/mcdata.js';
import minecraftData from 'minecraft-data';

function fixture() {
    loadMcData('1.20.4');                                   // knownNames()/validateTask need the module registry
    const v = Object.create(Voyager.prototype);
    v.agent = { bot: { registry: minecraftData('pc', '1.20.4') } };   // reg() = this.agent.bot.registry
    v.progress = { decomposed: {}, subgoals: [], failed: [], completedAt: {} };
    v._saveProgress = () => {};
    v._curSub = null;
    v.skills = [];
    v.retrieveSkills = async () => [];
    v._askLocal = async () => JSON.stringify({ subgoals: ['Collect 1 granite', 'Craft 1 stone_pickaxe'] });
    v._inferMeta = () => ({});
    v._stateText = () => 'state';
    v._deathHotspots = () => '';
    v.observe = () => ({ nearby_blocks: [], inventory: {} });
    return v;
}

test('fix176: a goal is decomposed at most MAX_GOAL_DECOMPOSES times then abandoned', async () => {
    const v = fixture();
    const task = 'Practice patting the wolf';
    assert.strictEqual(await v._decompose(task, 'r1'), true);
    assert.strictEqual(v.progress.decomposed[task].retries, 1);
    v.progress.subgoals.length = 0;             // queue consumed by pursuit
    assert.strictEqual(await v._decompose(task, 'r2'), true);
    assert.strictEqual(v.progress.decomposed[task].retries, 2);
    v.progress.subgoals.length = 0;
    assert.strictEqual(await v._decompose(task, 'r3'), false);   // third cycle: abandoned
    assert.ok(!Object.hasOwn(v.progress.decomposed, task));
    assert.ok(v.progress.failed.some(f => f.startsWith(task) && /abandoned: decomposed 2x/.test(f)));
    assert.strictEqual(v.progress.subgoals.length, 0);           // no new retry enqueued
});

test('fix176: a success after decomposing resets the goal budget', async () => {
    const v = fixture();
    const task = 'Practice patting the wolf';
    await v._decompose(task, 'r1');
    v.progress.subgoals.length = 0;
    await v._decompose(task, 'r2');
    v.progress.subgoals.length = 0;
    v.progress.completedAt[task] = Date.now() + 1;   // completed after the last decomposition
    assert.strictEqual(await v._decompose(task, 'r3'), true);
    assert.strictEqual(v.progress.decomposed[task].retries, 1);
});

test('fix176: queued subgoals still short-circuit decomposition before the cap', async () => {
    const v = fixture();
    const task = 'Practice patting the wolf';
    await v._decompose(task, 'r1');
    v.progress.subgoals[0] = { task: 'Collect 1 granite', parent: task, depth: 1 };
    assert.strictEqual(await v._decompose(task, 'r2'), false);
    assert.ok(v.progress.failed.every(f => !f.includes('abandoned')), 'queued check is not an abandonment');
});
