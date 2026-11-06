/**
 * fix55: one goal resolver (item | ensure | skill | open | invalid).
 * - a goal naming a known skill is verified by that skill's learned post-contract (_postHolds), never item counts
 * - free text is an open goal: never "already satisfied" by scraped item counts
 * - a bare identifier that is not a usable skill is rejected back to the planner
 * - repeat proposals of a failing goal are backed off by its learned posterior success
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';

const SHELTER = { name: 'buildShelter', task: 'Shelter for the night', description: 'Get safe for the night', code: 'async function buildShelter(bot) {\n    return await shelterNow(bot);\n}', deps: [], stats: { success: 1, fail: 0, tasks: [] }, effects: [], consumes: {}, contract: { pre: 'c => c.args.length === 0', post: 'c => c.ret' } };
const EQUIP = { name: 'equipBestTool', code: 'async function equipBestTool(bot, toolType) { return null; }', deps: [], stats: { success: 0, fail: 0, tasks: [] }, contract: { pre: 'c => true', post: 'c => true' } };
const NOCONTRACT = { name: 'craftBed', code: 'async function craftBed(bot) { return true; }', deps: [], stats: { success: 0, fail: 0, tasks: [] } };
const eq = { hand: 'empty', off_hand: 'empty', head: 'empty', torso: 'empty', legs: 'empty', feet: 'empty' };

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest('1.21.4');
});

function mk(skills) {
    const v = Object.create(Voyager.prototype);
    v.skills = skills.map(s => JSON.parse(JSON.stringify(s)));
    v.progress = { completed: [], failed: [], goalStats: {}, fix25: true };
    v.npGraph = { consumesOf: () => ({}), getProducersOf: () => [], getRequirementsOf: () => [], recordDelta: () => {} };
    v._saveProgress = () => {};
    v._saveSkills = () => {};
    return v;
}

describe('fix55 _resolveGoal kinds', () => {
    it('bare known skill name with a learned post -> skill', () => {
        const g = mk([SHELTER])._resolveGoal('buildShelter');
        assert.strictEqual(g.kind, 'skill');
        assert.strictEqual(g.skill.name, 'buildShelter');
    });
    it('bare identifier that is not a skill -> invalid', () => {
        const g = mk([SHELTER])._resolveGoal('buildCastle');
        assert.strictEqual(g.kind, 'invalid');
        assert.ok(g.why.includes('neither an item goal'), g.why);
    });
    it('skill that needs arguments -> invalid, naming them', () => {
        const g = mk([EQUIP])._resolveGoal('equipBestTool');
        assert.strictEqual(g.kind, 'invalid');
        assert.ok(g.why.includes('toolType'), g.why);
    });
    it('skill without a learned post-contract -> invalid, contract learning queued', () => {
        const v = mk([{ ...NOCONTRACT, contractTried: 1 }]);
        const g = v._resolveGoal('craftBed');
        assert.strictEqual(g.kind, 'invalid');
        assert.ok(!('contractTried' in v.skills[0]), 'contractTried cleared so _backfillContracts learns it');
    });
    it('demoted / merged skills -> invalid', () => {
        assert.strictEqual(mk([{ ...SHELTER, demoted: true }])._resolveGoal('buildShelter').kind, 'invalid');
        assert.ok(mk([{ ...SHELTER, mergedInto: 'shelterX' }])._resolveGoal('buildShelter').why.includes('shelterX'));
    });
    it('free text -> open (camelCase / item scraping no longer used)', () => {
        for (const t of ['Toss 10 surplus coal, 5 dirt, and 3 stone to free inventory space', 'Equip the stone_pickaxe if crafted and no better pickaxe is available', 'Build a 5x5 cobblestone floor next to the hut'])
            assert.strictEqual(mk([SHELTER])._resolveGoal(t).kind, 'open', t);
    });
    it('empty task fails loud', () => {
        assert.throws(() => mk([])._resolveGoal('  '), /LOUD FAIL/);
    });
});

describe('fix55 item goals unchanged', () => {
    it('counted and smelt goals resolve as before', () => {
        const v = mk([SHELTER]);
        const c = v._resolveGoal('Craft 1 iron_pickaxe');
        assert.deepStrictEqual([c.kind, c.item, c.count, c.verb], ['item', 'iron_pickaxe', 1, 'craft']);
        const s = v._resolveGoal('Smelt 3 raw_iron into 3 iron_ingot');
        assert.deepStrictEqual([s.kind, s.item, s.count, s.input], ['item', 'iron_ingot', 3, 'raw_iron']);
        const m = v._resolveGoal('mine 3 iron ore');
        assert.strictEqual(m.item, 'iron_ore');
        assert.ok(m.items.includes('raw_iron'), 'mined block loot still counted');
    });
    it('satisfaction of item goals is the exact inventory count', () => {
        const v = mk([SHELTER]);
        assert.strictEqual(v._goalAlreadySatisfied('Craft 1 iron_pickaxe', { inventory: { iron_pickaxe: 1 }, equipment: eq }).satisfied, true);
        const r = v._goalAlreadySatisfied('Craft 1 iron_pickaxe', { inventory: { stone_pickaxe: 3 }, equipment: eq });
        assert.strictEqual(r.satisfied, false);
        assert.ok(r.reason.includes('have 0'), r.reason);
    });
    it('ensure goals read observe().nearby_blocks (exact name)', () => {
        const v = mk([]);
        assert.strictEqual(v._goalAlreadySatisfied('ensure furnace', { inventory: {}, nearby_blocks: ['furnace', 'stone'] }).satisfied, true);
        assert.strictEqual(v._goalAlreadySatisfied('ensure furnace', { inventory: { furnace: 1 }, nearby_blocks: ['blast_furnace'] }).satisfied, false);
        assert.throws(() => v._goalAlreadySatisfied('ensure furnace', { inventory: {} }), /nearby_blocks/);
    });
});

describe('fix55 no false "already satisfied" for free text (live 284639 / 285836)', () => {
    it('"Toss 10 surplus coal, 5 dirt..." with 24 dirt is NOT satisfied', () => {
        const r = mk([SHELTER])._goalAlreadySatisfied('Toss 10 surplus coal, 5 dirt, and 3 stone to free inventory space', { inventory: { dirt: 24, coal: 40, stone: 9 }, equipment: eq });
        assert.strictEqual(r.satisfied, false, r.reason);
    });
    it('"Equip the stone_pickaxe ..." with 3 stone_pickaxe is NOT satisfied', () => {
        const r = mk([SHELTER])._goalAlreadySatisfied('Equip the stone_pickaxe if crafted and no better pickaxe is available', { inventory: { stone_pickaxe: 3 }, equipment: eq });
        assert.strictEqual(r.satisfied, false, r.reason);
    });
    it('skill goal is verified after it runs, not before', () => {
        const r = mk([SHELTER])._goalAlreadySatisfied('buildShelter', { inventory: { cobblestone: 320 }, equipment: eq });
        assert.strictEqual(r.satisfied, false);
        assert.ok(r.reason.includes('post-contract'), r.reason);
    });
});

// a replay harness: the staged program "runs" by writing the root trace record the PSN wrapper would record
function replayHarness(skills, rootRecord) {
    const v = mk(skills);
    const bot = { output: '', inventory: { emptySlotCount: () => 10 }, entity: { position: { x: 0, y: 64, z: 0 } } };
    const state = { inventory: { cobblestone: 20 }, equipment: eq, nearby_blocks: [] };
    v.agent = {
        bot,
        coder: {
            _lintCode: async () => null,
            _stageCode: async (_bundle, opts) => {
                const preludeLines = 0;
                if (opts?.lintOnly) return { src_lint_copy: '', preludeLines };
                return { func: { main: async b => { b.__psnTrace = rootRecord ? [rootRecord] : []; } }, src_lint_copy: '', preludeLines };
            }
        }
    };
    v.observe = () => state;
    v._run = async (label, fn) => { await fn(); return { success: true, message: '' }; };
    v._openTrialJournal = () => () => {};   // fix68: every run is journalled; this rig has no bot dir
    v._diedInRun = () => null; v._stalledInRun = () => null;
    v._precheck = () => ({ ok: true });
    v.recorded = [];
    v._recordRun = (e, t, ok) => v.recorded.push(ok);
    v._attribute = () => {};
    return { v, state };
}
const rec = rv => ({ name: 'buildShelter', parent: -1, depth: 0, argv: [], rv, s0: { pos: { x: 0, y: 64, z: 0 }, inv: {} }, s1: { pos: { x: 0, y: 64, z: 0 }, inv: {} }, delta: {} });

describe('fix55 buildShelter replay verified by its learned post-contract', () => {
    it('shelterNow returned true -> post "c => c.ret" holds -> replay PASSED (no item count)', async () => {
        const { v, state } = replayHarness([SHELTER], rec(true));
        const rp = await v._replay('buildShelter', state, { name: 'buildShelter', call: 'await buildShelter(bot);' });
        assert.strictEqual(rp.ok, true);
        assert.deepStrictEqual(v.recorded, [true]);
    });
    it('shelterNow returned false -> post does not hold -> replay failed', async () => {
        const { v, state } = replayHarness([SHELTER], rec(false));
        const rp = await v._replay('buildShelter', state, { name: 'buildShelter', call: 'await buildShelter(bot);' });
        assert.strictEqual(rp.ok, false);
    });
    it('a different skill run on the skill goal is NOT satisfied', async () => {
        const other = { ...SHELTER, name: 'shelterOther', code: 'async function shelterOther(bot) { return true; }' };
        const { v, state } = replayHarness([SHELTER, other], { ...rec(true), name: 'shelterOther' });
        const rp = await v._replay('buildShelter', state, { name: 'shelterOther', call: 'await shelterOther(bot);' });
        assert.strictEqual(rp.ok, false);
    });
    it('open goal: routed skill post-contract decides, item counts ignored', async () => {
        const { v, state } = replayHarness([SHELTER], rec(true));
        const rp = await v._replay('Get safe before night with 5 dirt', state, { name: 'buildShelter', call: 'await buildShelter(bot);' });
        assert.strictEqual(rp.ok, true);
    });
    it('invalid goal is never replayed', async () => {
        const { v, state } = replayHarness([SHELTER], rec(true));
        let staged = false; v.agent.coder._stageCode = async () => { staged = true; };
        const rp = await v._replay('buildCastle', state, { name: 'buildShelter', call: 'await buildShelter(bot);' });
        assert.strictEqual(rp.ok, false);
        assert.strictEqual(staged, false);
    });
});

describe('fix55 invalid goal is rejected back to the planner', () => {
    it('_step rejects "buildCastle", re-proposes with the reason as a note', async () => {
        const v = mk([SHELTER]);
        for (const m of ['_checkHomeGround', '_watchWindows', '_watchDimension', '_oneshot', '_requeueDeferred']) v[m] = () => {};
        for (const m of ['_queueApiLintRepairs', '_gateTrial', '_backfillContracts', '_refactor', '_prune', '_generalise', '_split', '_retention', '_idlePractice']) v[m] = async () => false;
        v.agent = { bot: { currentWindow: null } };
        v.observe = () => ({ inventory: {}, equipment: eq });
        v._subgoalTask = () => null;
        v._takePlan = async () => ({ task: 'buildCastle', reasoning: 'r' });
        const notes = [];
        v.proposeTask = async st => { notes.push(st.note); return { task: 'buildCastle', reasoning: 'r' }; };
        let ran = false; v._goalAlreadySatisfied = () => { ran = true; return { satisfied: false, reason: '' }; };
        await v._step();
        assert.strictEqual(notes.length, 1);
        assert.ok(notes[0].includes('"buildCastle" was rejected') && notes[0].includes('neither an item goal'), notes[0]);
        assert.ok(v.progress.failed[0].includes('(invalid:'), v.progress.failed[0]);
        assert.strictEqual(ran, false, 'nothing runs for an invalid goal');
    });
});

describe('fix55 learned goal backoff', () => {
    const realRandom = Math.random;
    afterEach(() => { Math.random = realRandom; });
    it('no recorded failure -> multiplier 1, never backed off', () => {
        const v = mk([SHELTER]);
        v.progress.goalStats = { 'buildShelter::': { success: 4, fail: 0 } };
        assert.strictEqual(v._goalBackoffMultiplier('buildShelter'), 1);
        Math.random = () => 0.999;
        assert.strictEqual(v._rejectTask('buildShelter', true), null);
    });
    it('posterior over all failure reasons: 0 of 3 -> 1/5', () => {
        const v = mk([SHELTER]);
        v.progress.goalStats = { 'buildShelter::replay failed': { success: 0, fail: 2 }, 'buildShelter::failed 4x': { success: 0, fail: 1 }, 'other::': { success: 0, fail: 9 } };
        assert.strictEqual(v._goalBackoffMultiplier('buildShelter'), 1 / 5);
        Math.random = () => 0.5;
        assert.ok(v._rejectTask('buildShelter', true).includes('backed off: it succeeded 0 of 3'));
        Math.random = () => 0.1;
        assert.strictEqual(v._rejectTask('buildShelter', true), null, 'still retried at its learned rate');
    });
    it('queued subgoals are not backed off', () => {
        const v = mk([SHELTER]);
        v.progress.goalStats = { 'buildShelter::replay failed': { success: 0, fail: 5 } };
        Math.random = () => 0.999;
        assert.strictEqual(v._rejectTask('buildShelter', false), null);
    });
});

describe('fix55 source shape', () => {
    const src = readFileSync('./src/agent/voyager.js', 'utf8');
    it('_resolveGoalItemUnified and its registry substring scan are gone', () => {
        assert.ok(!src.includes('_resolveGoalItemUnified'));
        assert.ok(!src.includes('Final attempt: find item name'));
    });
    it('_postHolds has a caller and _goalBackoffMultiplier is used', () => {
        assert.ok(src.includes('this._postHolds(g.skill)') && src.includes('this._postHolds(entry)'));
        assert.ok(src.includes('this._goalBackoffMultiplier(task)'));
    });
    it('skill goals write no new code', () => {
        assert.ok(src.includes("if (goalKind.kind === 'skill') {"));
    });
});
