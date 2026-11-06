/**
 * fix56 (live iMac 10:58-11:01):
 * 1) open goal "Explore for iron ore deposit" routed to ensureFurnaceInRange by lexical overlap and "verified" by a vacuous post
 * 2) mineOneIronOre contract "repaired" on every passing run: trace inv/delta were always {} (world.* is not in the compartment)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { AsyncLocalStorage } from 'async_hooks';

const FURNACE = { name: 'ensureFurnaceInRange', task: 'Ensure a furnace is within 16 blocks', description: 'Ensures a furnace exists within 16 blocks', code: 'async function ensureFurnaceInRange(bot) { return true; }', deps: [], stats: { success: 3, fail: 1, tasks: [] }, effects: ['granite', 'dirt'], contract: { pre: 'c => c.pre.alive', post: 'c => !c.ret || (c.post.alive && c.pre.dim === c.post.dim)' } };
const MINE_POST = 'c => c.post.alive && ((c.post.inv.raw_iron || 0) >= (c.pre.inv.raw_iron || 0) + 1) && (c.post.pos !== c.pre.pos)';
const eq = { hand: 'empty', off_hand: 'empty', head: 'empty', torso: 'empty', legs: 'empty', feet: 'empty' };
const S = (inv) => ({ pos: { x: 0, y: 32, z: 0 }, hp: 20, food: 20, sky: 0, alive: true, dim: 'overworld', inv, eq: {} });

let Voyager, instrumentSrc;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest('1.21.4');
    instrumentSrc = (await import('../src/agent/skill_graph.js')).instrumentSrc;
});
function mk(skills) {
    const v = Object.create(Voyager.prototype);
    v.skills = skills.map(s => JSON.parse(JSON.stringify(s)));
    v.progress = { completed: [], failed: [], goalStats: {}, fix25: true, replayThreshold: 0.85 };
    v.npGraph = { recordDelta: () => {} };
    v._saveProgress = () => {}; v._saveSkills = () => {};
    v.queued = []; v._queueContractFix = (e, why) => v.queued.push([e.name, why]);
    return v;
}
const withTrace = (v, rec) => { v.agent = { bot: { __psnTrace: [rec] } }; return v; };
const root = (name, rv, s0, s1, delta) => ({ name, parent: -1, depth: 0, argv: [], rv, s0, s1, delta });

describe('fix56 _postVerifiesRun (acorn AST + null-run counterfactual)', () => {
    it('ensureFurnaceInRange post with ret true, nothing changed -> cannot verify (holds for a do-nothing run)', () => {
        const e = mk([FURNACE]).skills[0];
        const v = withTrace(mk([FURNACE]), root('ensureFurnaceInRange', true, S({}), S({}), {}));
        const r = v._postVerifiesRun(e);
        assert.strictEqual(r.ok, false);
        assert.ok(r.why.includes('did nothing'), r.why);
    });
    it('vacuous "!c.ret ||" pass with falsy ret -> cannot verify', () => {
        const e = { name: 'x', contract: { post: 'c => !c.ret || c.post.inv.raw_iron > c.pre.inv.raw_iron' } };
        const v = withTrace(mk([]), root('x', 0, S({ raw_iron: 1 }), S({ raw_iron: 3 }), { raw_iron: 2 }));
        assert.strictEqual(v._postVerifiesRun(e).ok, false);
    });
    it('post that reads only pre/args -> cannot verify (AST)', () => {
        const e = { name: 'x', contract: { post: 'c => c.pre.alive && c.args.length === 0' } };
        const v = withTrace(mk([]), root('x', true, S({}), S({}), {}));
        const r = v._postVerifiesRun(e);
        assert.strictEqual(r.ok, false);
        assert.ok(r.why.includes('nothing the run produced'), r.why);
    });
    it('buildShelter "c => c.ret" with ret true -> verifies (a do-nothing run would be false)', () => {
        const e = { name: 'buildShelter', contract: { post: 'c => c.ret' } };
        const v = withTrace(mk([]), root('buildShelter', true, S({}), S({}), {}));
        assert.strictEqual(v._postVerifiesRun(e).ok, true);
    });
    it('state-change post with ret undefined (mineOneIronOre shape) -> verifies from the change', () => {
        const e = { name: 'mineOneIronOre', contract: { post: MINE_POST } };
        const v = withTrace(mk([]), root('mineOneIronOre', undefined, S({ raw_iron: 1 }), S({ raw_iron: 3 }), { raw_iron: 2 }));
        assert.strictEqual(v._postVerifiesRun(e).ok, true);
    });
});

function replayHarness(skills, rec) {
    const v = mk(skills);
    const bot = { output: '', inventory: { emptySlotCount: () => 10 }, entity: { position: { x: 0, y: 64, z: 0 } } };
    const state = { inventory: {}, equipment: eq, nearby_blocks: [] };
    v.agent = {
        bot,
        coder: {
            _lintCode: async () => null,
            _stageCode: async (_bundle, opts) => {
                const preludeLines = 0;
                if (opts?.lintOnly) return { src_lint_copy: '', preludeLines };
                return { func: { main: async b => { b.__psnTrace = [rec]; } }, src_lint_copy: '', preludeLines };
            }
        }
    };
    v.observe = () => state;
    v._run = async (l, fn) => { await fn(); return { success: true, message: '' }; };
    v._openTrialJournal = () => () => {};   // fix68: every run is journalled; this rig has no bot dir
    v._diedInRun = () => null; v._stalledInRun = () => null; v._precheck = () => ({ ok: true });
    v.recorded = []; v._recordRun = (e, t, ok) => v.recorded.push(ok);
    v.attributed = []; v._attribute = (n, t, ok) => v.attributed.push(ok);
    return { v, state };
}

describe('fix56 open goal is not verified by a vacuous post', () => {
    it('"Explore for iron ore deposit" on ensureFurnaceInRange: NOT satisfied, unverified, contract repair queued, no run stats', async () => {
        const { v, state } = replayHarness([FURNACE], root('ensureFurnaceInRange', true, S({}), S({}), {}));
        const rp = await v._replay('Explore for iron ore deposit', state, { name: 'ensureFurnaceInRange', call: 'await ensureFurnaceInRange(bot);' });
        assert.strictEqual(rp.ok, false);
        assert.strictEqual(rp.unverified, true);
        assert.strictEqual(v.queued[0][0], 'ensureFurnaceInRange');
        assert.ok(v.queued[0][1].includes('cannot verify'), v.queued[0][1]);
        assert.deepStrictEqual(v.recorded, [], 'an unverified goal is not a pass or fail of the skill');
        assert.deepStrictEqual(v.attributed, [true], 'the skill met its own contract: no root blame for the goal');
    });
    it('the learned replay threshold does not move on an unverified replay', () => {
        const v = mk([]);
        v._learnReplayThreshold({ ok: false, unverified: true });
        assert.strictEqual(v.progress.replayThreshold, 0.85);
        v._learnReplayThreshold({ ok: false });
        assert.ok(v.progress.replayThreshold > 0.85);
    });
});

describe('fix56 open goals are never routed by lexical overlap', () => {
    it('lexical routing picks the unrelated well-rated skill (the live bug); structured routing does not', () => {
        const v = mk([FURNACE]);
        assert.strictEqual(v._lexicalReplay('Explore for iron ore deposit').name, 'ensureFurnaceInRange');
        assert.strictEqual(v._structuredReplay('Explore for iron ore deposit'), null);
        assert.strictEqual(v._structuredReplay('Ensure a furnace is within 16 blocks').name, 'ensureFurnaceInRange', 'exact task identity still routes');
    });
    it('_step routes an open goal via the embedding match, not _lexicalReplay', async () => {
        const v = mk([FURNACE]);
        for (const m of ['_checkHomeGround', '_watchWindows', '_watchDimension', '_oneshot', '_requeueDeferred', '_prefetchPlan']) v[m] = () => {};
        for (const m of ['_queueApiLintRepairs', '_gateTrial', '_backfillContracts', '_refactor', '_prune', '_generalise', '_split', '_retention', '_idlePractice']) v[m] = async () => false;
        v.agent = { bot: { currentWindow: null, version: '1.21.4' } };
        v.observe = () => ({ inventory: {}, equipment: eq });
        v._subgoalTask = () => null;
        v._takePlan = async () => ({ task: 'Explore for iron ore deposit', reasoning: 'r' });
        let lexical = 0, embed = 0, replayed = 0;
        v._lexicalReplay = () => { lexical++; return { name: 'ensureFurnaceInRange', call: 'x' }; };
        v._embedReplay = async () => { embed++; return null; };
        v._replay = async () => { replayed++; return { ok: false }; };
        v._backchain = async () => null;
        v._cursorLimited = () => true;
        await v._step();
        assert.deepStrictEqual([lexical, embed, replayed], [0, 1, 0]);
    });
});

describe('fix56 trace snapshots read the real inventory (root cause of the mineOneIronOre repair loop)', () => {
    it('instrumentSrc uses the bare getInventoryCounts endowment, no world.* and no catch-to-{}', () => {
        const src = instrumentSrc(['f']);
        assert.ok(!src.includes('world.getInventoryCounts'), 'world is not in the compartment');
        assert.ok(!src.includes('catch { return {}; }'));
    });
    it('a wrapped call records pre/post inv and delta from getInventoryCounts', async () => {
        const inv = { raw_iron: 1 };
        const bot = {
            __psnALS: new AsyncLocalStorage(), output: '', health: 20, food: 20, oxygenLevel: 300, game: { dimension: 'overworld' }, quickBarSlot: 0,
            inventory: { slots: [], emptySlotCount: () => 35 }, entity: { position: { x: 0, y: 32, z: 0, floored() { return { offset: () => ({}) }; } } },
            blockAt: () => ({ skyLight: 0 }), waitForTicks: async () => {},
        };
        const getInventoryCounts = () => ({ ...inv });
        const AsyncFunction = (async () => {}).constructor;
        // the wrapped skill mines: inventory changes inside the call
        const prog2 = new AsyncFunction('bot', 'getInventoryCounts', 'inv', `let mineOneIronOre = async (bot) => { inv.raw_iron += 2; return undefined; };\n${instrumentSrc(['mineOneIronOre'])}\nawait mineOneIronOre(bot); return bot.__psnTrace;`);
        const tr = await prog2(bot, getInventoryCounts, inv);
        assert.deepStrictEqual(tr[0].s0.inv, { raw_iron: 1 });
        assert.deepStrictEqual(tr[0].s1.inv, { raw_iron: 3 });
        assert.deepStrictEqual(tr[0].delta, { raw_iron: 2 });
        const v = mk([]);
        assert.strictEqual(v._compileContract(MINE_POST)({ args: [], ret: tr[0].rv, pre: tr[0].s0, post: tr[0].s1, delta: tr[0].delta }), true, 'the learned mineOneIronOre post now holds on a successful run');
    });
});

describe('fix56 contract repair that returns the same post is loud', () => {
    it('logs that the contract did not explain the violation', async () => {
        const v = mk([{ name: 'mineOneIronOre', description: 'd', code: 'async function mineOneIronOre(bot) {}', effects: [], contract: { pre: 'c => true', post: MINE_POST } }]);
        v._ask = async () => JSON.stringify({ mineOneIronOre: { pre: 'c => true', post: MINE_POST, text: 't' } });
        const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
        try { await v._learnContracts([v.skills[0]], 'contract repair', 'postcondition failed but the task check passed'); } finally { console.log = orig; }
        assert.ok(logs.some(l => l.includes('returned the SAME pre/post')), logs.join('\n'));
    });
});
