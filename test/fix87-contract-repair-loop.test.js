/**
 * fix87 (live icefox2000, 21:36–23:07 GMT 6 Nov):
 * equipBestToolForAxe ran a contract repair about every 5s, 511 times. Each step logged
 * `[contract] LOUD: contract repair of equipBestToolForAxe returned the SAME pre/post; violation
 * (post cannot verify a run: post also holds for a run that did nothing (ret undefined, no state change))`
 * and the contract stayed `pre c => c.pre.eq.heldItem !== 'iron_axe' | post c => c.post.eq.heldItem === 'iron_axe'`.
 * The same evidence was queued for checkInventoryForCookedMutton (×2) and equipBestToolForIronOre (×1).
 * Idle practice logged NO VERDICT with that "did nothing" reason, after an earlier SUCCESS (stats 3/3).
 *
 * The do-nothing counterfactual was applied to a run whose pre was already false (the axe was already
 * in hand, so the skill correctly changed nothing and the post was already true). That is not evidence
 * the post is vacuous. And a repair that echoed the same pre/post was installed and forgotten, so the
 * next step queued it again.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

const AXE_PRE = "c => c.pre.eq.heldItem !== 'iron_axe'";
const AXE_POST = "c => c.post.eq.heldItem === 'iron_axe'";
const MUTTON_PRE = 'c => c.pre.inv.cooked_mutton < 1';
const MUTTON_POST = 'c => c.post.inv.cooked_mutton >= 1';
const ORE_PRE = "c => c.pre.eq.heldItem !== 'iron_pickaxe'";
const ORE_POST = "c => c.post.eq.heldItem === 'iron_pickaxe'";
const DID_NOTHING = 'post also holds for a run that did nothing (ret undefined, no state change)';

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest('1.21.4');
});

function skill(name, pre, post) {
    return {
        name, description: name, code: `async function ${name}(bot) { return; }`, deps: [], effects: [],
        stats: { success: 0, fail: 0, tasks: [] },
        contract: { pre, post, text: name },
    };
}
function state({ held = null, inv = {} } = {}) {
    return {
        pos: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, sky: 15, alive: true, dim: 'overworld', inv, free: 30,
        eq: { heldItem: held, offHand: null, helmet: null, chestplate: null, leggings: null, boots: null },
    };
}
// ret undefined, post state = pre state, empty delta: the live no-op trace
function noop(name, s) {
    return { name, parent: -1, depth: 0, argv: [], rv: undefined, fail: false, s0: s, s1: s, delta: {} };
}
function mk(skills) {
    const v = Object.create(Voyager.prototype);
    v.skills = skills.map(s => JSON.parse(JSON.stringify(s)));
    v.progress = { repairQueue: [] };
    v._saveProgress = () => {};
    v._saveSkills = () => {};
    v._cursorLimited = () => false;
    v.agent = { bot: { __psnTrace: [] } };
    return v;
}
function withTrace(v, rec) { v.agent.bot.__psnTrace = [rec]; return v; }

const ALREADY = [
    ['equipBestToolForAxe', AXE_PRE, AXE_POST, state({ held: 'iron_axe' })],
    ['checkInventoryForCookedMutton', MUTTON_PRE, MUTTON_POST, state({ inv: { cooked_mutton: 2 } })],
    ['equipBestToolForIronOre', ORE_PRE, ORE_POST, state({ held: 'iron_pickaxe' })],
];

describe('fix87 A: a pre-false no-op is not a contract violation', () => {
    for (const [name, pre, post, s] of ALREADY) {
        it(`${name}: pre is false, post holds, nothing changed -> no violation and no repair, on later steps too`, () => {
            const v = withTrace(mk([skill(name, pre, post)]), noop(name, s));
            const e = v.skills[0];
            const judged = v._postVerifiesRun(e);
            assert.strictEqual(judged.ok, null, judged.why);
            assert.ok(!judged.why.includes('did nothing'), judged.why);
            for (let step = 0; step < 3; step++) {
                const verdict = v._practiceRunChanged(e, {}, {});
                assert.strictEqual(verdict.ok, null, verdict.detail);
                assert.ok(!verdict.detail.includes('did nothing'), verdict.detail);
                assert.ok(!verdict.detail.includes('queued contract repair'), verdict.detail);
                assert.deepStrictEqual(v._repairQueue, []);
            }
        });
    }
    it('equipping the axe when it was not held still verifies (the earlier SUCCESS path)', () => {
        const before = state({ held: null });
        const after = state({ held: 'iron_axe' });
        const rec = { name: 'equipBestToolForAxe', parent: -1, depth: 0, argv: [], rv: 'iron_axe', fail: false, s0: before, s1: after, delta: {} };
        const v = withTrace(mk([skill('equipBestToolForAxe', AXE_PRE, AXE_POST)]), rec);
        const verdict = v._practiceRunChanged(v.skills[0], {}, {});
        assert.strictEqual(verdict.ok, true, verdict.detail);
        assert.deepStrictEqual(v._repairQueue, []);
    });
});

describe('fix87 B: a do-nothing run whose pre held is still a bad post', () => {
    for (const name of ['equipBestToolForAxe', 'checkInventoryForCookedMutton', 'equipBestToolForIronOre']) {
        it(`${name}: pre held, post holds of the unchanged state -> flagged and queued once`, () => {
            const v = withTrace(mk([skill(name, 'c => c.pre.alive', 'c => c.post.alive')]), noop(name, state({})));
            const verdict = v._practiceRunChanged(v.skills[0], {}, {});
            assert.strictEqual(verdict.ok, null);
            assert.ok(verdict.detail.includes(DID_NOTHING), verdict.detail);
            assert.strictEqual(v._repairQueue.length, 1);
            assert.strictEqual(v._repairQueue[0].kind, 'contract_fix');
            assert.ok(v._repairQueue[0].evidence.includes(DID_NOTHING), v._repairQueue[0].evidence);
            v._practiceRunChanged(v.skills[0], {}, {});
            assert.strictEqual(v._repairQueue.length, 1, 'the same skill is not queued twice while one repair is pending');
        });
    }
    it('a falsy-ret vacuous guard is still flagged when pre held', () => {
        const e = skill('x', 'c => true', 'c => !c.ret || c.post.inv.raw_iron > c.pre.inv.raw_iron');
        const s0 = state({ inv: { raw_iron: 1 } });
        const s1 = state({ inv: { raw_iron: 3 } });
        const rec = { name: 'x', parent: -1, depth: 0, argv: [], rv: 0, fail: false, s0, s1, delta: { raw_iron: 2 } };
        const v = withTrace(mk([e]), rec);
        const judged = v._postVerifiesRun(v.skills[0]);
        assert.strictEqual(judged.ok, false);
        assert.ok(judged.why.includes('did nothing') || judged.why.includes('vacuous'), judged.why);
    });
});

describe('fix87 C: a repair that returns the same pre/post is rejected once', () => {
    it('is loud, leaves the contract in place, and is not run again on the next steps', async () => {
        const pre = 'c => c.pre.alive';
        const post = 'c => c.post.alive && c.pre.dim === c.post.dim';
        const v = withTrace(mk([skill('equipBestToolForAxe', pre, post)]), noop('equipBestToolForAxe', state({})));
        const e = v.skills[0];
        const contract = e.contract;
        let asks = 0;
        v._ask = async () => {
            asks++;
            // live race: idle practice judges the same run during the code-model call, before the reply is compared
            if (asks === 1) v._practiceRunChanged(e, {}, {});
            return JSON.stringify({ equipBestToolForAxe: { pre, post, text: 'same' } });
        };
        const logs = [];
        const orig = console.log;
        console.log = (...a) => logs.push(a.join(' '));
        try {
            const first = v._practiceRunChanged(e, {}, {});
            assert.strictEqual(first.ok, null);
            assert.ok(first.detail.includes(DID_NOTHING), first.detail);
            assert.strictEqual(v._repairQueue.length, 1);
            const evidence = v._repairQueue[0].evidence;
            // fix95: that run is learned on the skill; this exact contract is not used to judge practice again
            assert.strictEqual(e.postUnverifiable.post, post);
            assert.strictEqual(e.postUnverifiable.pre, pre);
            assert.strictEqual(v._practiceJudgeable(e), false);
            assert.strictEqual(await v._repair(), false);
            assert.strictEqual(asks, 1);
            assert.strictEqual(e.contract, contract, 'the identical pre/post is not installed');
            assert.strictEqual(e.contract.pre, pre);
            assert.strictEqual(e.contract.post, post);
            assert.strictEqual(Object.hasOwn(e, 'contractPrev'), false);
            assert.ok(logs.some(l => l.includes('returned the SAME pre/post')), logs.join('\n'));
            assert.strictEqual(e.repairHistory.at(-1).outcome, 'rejected same contract');
            // fix95: the practice run during the model call no longer re-judges on this contract, so it re-queues nothing
            assert.strictEqual(v._repairQueue.length, 0, 'practice re-queued a repair on a contract already shown unable to verify a run');
            for (let step = 0; step < 3; step++) {
                const again = v._practiceRunChanged(e, {}, {});
                assert.strictEqual(again.ok, null);
                assert.ok(!again.detail.includes(DID_NOTHING), again.detail);
                v._queueContractFix(e, evidence);
                while (v._repairQueue.length) {
                    const before = asks;
                    assert.strictEqual(await v._repair(), false);
                    assert.strictEqual(asks, before, `step ${step} called the code model`);
                }
            }
            assert.strictEqual(asks, 1);
            assert.ok(logs.some(l => l.includes('not re-queued')), logs.join('\n'));
        } finally { console.log = orig; }
        const other = 'post threw: TypeError: c.post.pos.dist is not a function';
        v._queueContractFix(e, other);
        assert.strictEqual(v._repairQueue.length, 1);
        assert.strictEqual(v._repairQueue[0].evidence, other);
        const next = "c => c.post.eq.heldItem === 'iron_axe'";
        v._ask = async () => { asks++; return JSON.stringify({ equipBestToolForAxe: { pre, post: next, text: 'holds the axe' } }); };
        assert.strictEqual(await v._repair(), true);
        assert.strictEqual(asks, 2);
        assert.strictEqual(e.contract.post, next);
        // fix95: a changed contract judges practice again
        assert.strictEqual(v._practiceJudgeable(e), true);
    });
});

function replayHarness(one, rec) {
    const v = mk([one]);
    const bot = { output: '', inventory: { emptySlotCount: () => 10 }, entity: { position: { x: 0, y: 64, z: 0 } } };
    const observed = { inventory: rec.s0.inv, nearby_blocks: [] };
    v.agent = {
        bot,
        coder: {
            _lintCode: async () => null,
            _stageCode: async (_bundle, opts) => {
                const preludeLines = 0;
                if (opts && opts.lintOnly) return { src_lint_copy: '', preludeLines };
                return { func: { main: async b => { b.__psnTrace = [rec]; } }, src_lint_copy: '', preludeLines };
            },
        },
    };
    v.observe = () => observed;
    v._run = async (_l, fn) => { await fn(); return { success: true, message: '' }; };
    v._openTrialJournal = () => () => {};
    v._diedInRun = () => null;
    v._stalledInRun = () => null;
    v._precheck = () => ({ ok: true });
    v.recorded = [];
    v._recordRun = () => { v.recorded.push('stats'); };
    v._attribute = () => undefined;
    return v;
}

describe('fix87: open goals use the same pre-held rule', () => {
    for (const [name, pre, post, s, task] of [
        ['equipBestToolForAxe', AXE_PRE, AXE_POST, state({ held: 'iron_axe' }), 'Equip the best axe'],
        ['checkInventoryForCookedMutton', MUTTON_PRE, MUTTON_POST, state({ inv: { cooked_mutton: 2 } }), 'See whether cooked mutton is already in the inventory'],
        ['equipBestToolForIronOre', ORE_PRE, ORE_POST, state({ held: 'iron_pickaxe' }), 'Equip a tool that can mine iron ore'],
    ]) {
        it(`${name} on an open goal: not verified, no contract repair, no run stats`, async () => {
            const v = replayHarness(skill(name, pre, post), noop(name, s));
            const rp = await v._replay(task, v.observe(), { name, call: `await ${name}(bot);` });
            assert.strictEqual(rp.ok, false);
            assert.strictEqual(rp.unverified, true);
            assert.deepStrictEqual(v._repairQueue, []);
            assert.deepStrictEqual(v.recorded, []);
        });
    }
});
