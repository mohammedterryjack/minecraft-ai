/**
 * fix79 (live iMac, 2026-11-06): "[voyager] replay scanForIronOreBlocks: failed (+0 diamond_ore/diamond)" every 5-7 min.
 * 04:14Z generated mineOneDiamondOre called scanForIronOreBlocks, which found no iron and returned null; blame path
 * mineOneDiamondOre > scanForIronOreBlocks queued a callee repair of it with q.task "Mine 1 diamond_ore". The repair (04:17Z)
 * set candidate.trialTask = q.task (fix28, c3025b8), so _gateTrial replayed scanForIronOreBlocks ALONE as the route of
 * "Mine 1 diamond_ore". The candidate's effects [] did not overlap the goal, so #30's gate (094b9db) ran the INCUMBENT instead,
 * which met its contract (scanned, returned blocks), gained 0 diamond, and was charged the failure: stats.fail, DEMOTE, and a
 * root "every call met its contract but the task outcome failed" repair. The route, not the skill, was wrong.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/fix79-live-scanForIronOreBlocks.json', import.meta.url), 'utf8'));
const DIAMOND = 'Mine 1 diamond_ore';
let Voyager, MISROUTED, NeedsProducesGraph;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager; MISROUTED = mod.MISROUTED;
    mod._setVersionForTest('1.21.4');
    NeedsProducesGraph = (await import('../src/agent/needs_produces.js')).NeedsProducesGraph;
});
// the 17:16 reset state: TypeError fails cleared, the 7 misroute fails left, demotion cleared
const afterReset = () => ({ ...JSON.parse(JSON.stringify(LIVE)), stats: { ...LIVE.stats, fail: 7, streakFail: 7 }, demoted: false });
const confirmed = links => Object.assign(Object.create(NeedsProducesGraph.prototype), { confirmed: links, recordDelta: () => {} });
const scanRoot = (t, extra = {}) => ({ name: 'scanForIronOreBlocks', args: '[]', parent: -1, depth: 0, o0: 0, o1: 0, t0: t - 5, t1: t, ret: '[{"type":41,"metadata":0}]', rv: null, ...extra });

/** _replay with the real _attribute and _recordRun; only staging, the world and the persistence are stubbed. */
function rig(skills, rec, links = {}) {
    const v = Object.create(Voyager.prototype);
    v.skills = skills;
    v.progress = { completed: [], failed: [], goalStats: {}, replayThreshold: 0.85 };
    v.npGraph = confirmed(links);
    v._saveSkills = () => {}; v._saveProgress = () => {};
    const bot = { output: '', inventory: { emptySlotCount: () => 1 }, entity: { position: { x: -27, y: 66, z: 70 } }, food: 20 };
    v.agent = { bot };
    const inv = { raw_iron: 114, cobblestone: 410 };
    v.observe = () => ({ inventory: { ...inv }, equipment: {}, nearby_blocks: [], food_value: 20 });
    v._stageLintExecTraced = async () => ({ lint: null, staged: { func: { main: async b => { b.__psnTrace = [rec(Date.now())]; b.__psnOut = ''; } } } });
    v._openTrialJournal = () => () => {};
    v._timedBotForSkillRun = () => bot;
    v._run = async (l, fn) => { await fn(); return { success: true, message: 'Code finished.' }; };
    v._diedInRun = () => null; v._stalledInRun = () => null; v._crashedInRun = () => null; v._lastRunTimedOut = false;
    v._foodRaiseSaturated = () => null; v._libraryFault = () => false; v._classifyUnmetPrecondition = () => null;
    v._failureNeeds = () => null; v._detectInventoryFullFailure = () => null;   // fix81: the structured-needs chain (was _tryDecomposePrerequisiteFailure) is not under test here
    v._learnRunDurations = () => {}; v._checkContracts = () => {}; v._learnVitalsEffects = () => {}; v._learnSlotEffects = () => {};
    v._prefetchBlamedEmbeds = () => {};
    v.logs = [];
    return v;
}
async function quiet(v, fn) {
    const log = console.log; console.log = (...a) => { v.logs.push(a.join(' ')); };
    try { return await fn(); } finally { console.log = log; }
}

describe('fix79 the live diamond -> scanForIronOreBlocks replay', () => {
    it('incumbent met its contract on "Mine 1 diamond_ore": not charged, not demoted, not repaired; the route is blamed', async () => {
        const v = rig([afterReset()], t => scanRoot(t));
        const rp = await quiet(v, () => v._replay(DIAMOND, v.observe(), { name: 'scanForIronOreBlocks', call: 'await scanForIronOreBlocks(bot);' }));
        const e = v.skills[0];
        assert.strictEqual(rp.ok, false, 'the goal did not pass');
        assert.ok(rp.misrouted && rp.misrouted.fits === false, 'the route is the failure');
        assert.deepStrictEqual(rp.misrouted.items, ['diamond_ore', 'diamond']);
        assert.ok(rp.reason.startsWith('misrouted: scanForIronOreBlocks'), rp.reason);
        assert.deepStrictEqual([e.stats.fail, e.stats.streakFail, e.demoted], [7, 7, false], 'live: 7 -> 8 and DEMOTE "failed 3 times in a row"');
        assert.strictEqual((v._repairQueue || []).length, 0, 'live: "blame: root learned skill scanForIronOreBlocks [callee_fix]" + queued REPAIR');
        assert.ok(v.logs.some(l => l.includes('[blame] MISROUTE: scanForIronOreBlocks')), v.logs.join('\n'));
        assert.ok(!v.logs.some(l => l.includes('DEMOTE')));
    });
    it('the misroute still counts against the route: the learned embedding threshold rises', () => {
        const v = rig([], () => null);
        v._learnReplayThreshold({ ok: false, misrouted: { fits: false } });
        assert.ok(v.progress.replayThreshold > 0.85);
    });
    it('contrast: a skill learned to produce the goal that met its contract and gained nothing IS blamed', async () => {
        const s = { ...afterReset(), effects: ['diamond'] };
        const v = rig([s], t => scanRoot(t));
        const rp = await quiet(v, () => v._replay(DIAMOND, v.observe(), { name: 'scanForIronOreBlocks', call: 'await scanForIronOreBlocks(bot);' }));
        assert.strictEqual(rp.misrouted, undefined);
        assert.deepStrictEqual([v.skills[0].stats.fail, v.skills[0].demoted], [8, true]);
        assert.strictEqual(v._repairQueue[0].target, 'scanForIronOreBlocks');
    });
    it('learned evidence includes needs/produces links confirmed for the skill (same key recordDelta files under)', async () => {
        const v = rig([afterReset()], t => scanRoot(t), { scanforironoreblocks: { needs: [], produces: ['diamond'] } });
        const rp = await quiet(v, () => v._replay(DIAMOND, v.observe(), { name: 'scanForIronOreBlocks', call: 'await scanForIronOreBlocks(bot);' }));
        assert.strictEqual(rp.misrouted, undefined);
        assert.strictEqual(v.skills[0].stats.fail, 8);
    });
    it('a misrouted skill whose own call failed is still blamed for that failure', async () => {
        const v = rig([afterReset()], t => scanRoot(t, { fail: true, err: 'getNearestBlocks is not a function', ret: undefined }));
        const rp = await quiet(v, () => v._replay(DIAMOND, v.observe(), { name: 'scanForIronOreBlocks', call: 'await scanForIronOreBlocks(bot);' }));
        assert.strictEqual(rp.misrouted, undefined);
        assert.strictEqual(v.skills[0].stats.fail, 8);
        assert.strictEqual(v._repairQueue[0].target, 'scanForIronOreBlocks');
    });
    it('parametrised contract routes (mineOre(bot, item, n)) are judged by their contract, not by route evidence', () => {
        const v = rig([], () => null);
        assert.notStrictEqual(v._contract({ name: 'mineOre', call: 'await mineOre(bot, "diamond_ore", 1);' }), null);
    });
});

describe('fix79 dedicated gate trial route is chosen from learned evidence', () => {
    const gateRig = (s) => { s.candidate.trialAfter = 0; const v = rig([s], t => scanRoot(t)); v.replayed = []; v._replay = async (task, b, r) => { v.replayed.push([task, r]); return { ok: false }; }; return v; };
    it('live candidate (effects []) with trialTask "Mine 1 diamond_ore": no replay, trialTask dropped loudly', async () => {
        const v = gateRig(afterReset());
        const ran = await quiet(v, () => v._gateTrial());
        assert.strictEqual(ran, false);
        assert.deepStrictEqual(v.replayed, []);
        assert.strictEqual(v.skills[0].candidate.trialTask, undefined);
        assert.ok(v.logs.some(l => l.includes('LOUD: no dedicated trial of scanForIronOreBlocks on "Mine 1 diamond_ore"')), v.logs.join('\n'));
    });
    it('a candidate learned to produce the goal gets its dedicated trial, flagged as one', async () => {
        const s = afterReset(); s.candidate.effects = ['diamond'];
        const v = gateRig(s);
        await quiet(v, () => v._gateTrial());
        assert.deepStrictEqual(v.replayed.map(([t, r]) => [t, r.name, r.dedicatedTrial]), [[DIAMOND, 'scanForIronOreBlocks', true]]);
    });
    it('_replay refuses to turn a dedicated trial into an incumbent run', async () => {
        const v = rig([afterReset()], t => scanRoot(t));
        await assert.rejects(quiet(v, () => v._replay(DIAMOND, v.observe(), { name: 'scanForIronOreBlocks', call: 'await scanForIronOreBlocks(bot);', dedicatedTrial: true })), /\[fix79\] dedicated trial of scanForIronOreBlocks/);
        assert.deepStrictEqual([v.skills[0].stats.fail, v.skills[0].demoted], [7, false]);
    });
});

describe('fix79 a repaired callee is not given its caller\'s task as a dedicated route', () => {
    const cand = () => { const s = afterReset(); delete s.candidate.trialTask; return s; };
    it('path mineOneDiamondOre > scanForIronOreBlocks (live 04:14Z): no trialTask', async () => {
        const v = rig([cand()], () => null);
        await quiet(v, () => v._setTrialTask(v.skills[0], { task: DIAMOND, path: ['mineOneDiamondOre', 'scanForIronOreBlocks'] }));
        assert.strictEqual(v.skills[0].candidate.trialTask, undefined);
        assert.ok(v.logs.some(l => l.includes('it ran inside mineOneDiamondOre')));
    });
    it('the skill was the route (path starts at it): trialTask set', () => {
        const v = rig([cand()], () => null);
        v._setTrialTask(v.skills[0], { task: 'Mine 1 iron_ore', path: ['scanForIronOreBlocks'] });
        assert.strictEqual(v.skills[0].candidate.trialTask, 'Mine 1 iron_ore');
    });
    it('a repair record without a blame path fails loudly', () => {
        const v = rig([cand()], () => null);
        assert.throws(() => v._setTrialTask(v.skills[0], { task: DIAMOND }), /no blame path/);
    });
});

describe('fix79 every _attribute call states its route evidence', () => {
    it('undefined route throws', () => {
        const v = rig([], () => null);
        assert.throws(() => v._attribute('x', 't', false, {}), /needs route evidence/);
    });
    it('every call site in voyager.js passes five arguments', () => {
        const src = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
        const calls = src.match(/this\._attribute\([^;]*\);/g);
        assert.ok(calls.length >= 2);
        for (const c of calls) assert.ok(/,\s*(routeFit|null)\);$/.test(c), c);
    });
    it('MISROUTED is exported for callers', () => assert.strictEqual(typeof MISROUTED, 'string'));
});

// the live deferred misroute repair (iMac progress.json deferredRepairs[4] at 17:46) beside an unrelated one
const LIVE_PROGRESS = {
    deferredRepairs: [
        { target: 'ensureFurnace', leaf: 'ensureFurnace', path: ['ensureFurnace'], kind: 'callee_fix', swallowed: false, evidence: 'x', task: 'lint against the current built-in API', defers: 1, notBefore: 1 },
        { target: 'scanForIronOreBlocks', leaf: 'scanForIronOreBlocks', path: ['scanForIronOreBlocks'], kind: 'callee_fix', swallowed: false, evidence: 'every call met its contract but the task outcome failed', task: 'Mine 1 diamond_ore', trace: 'scanForIronOreBlocks() -> [{"type":41,"metadata":0,"light":0,"skyLight":0,"biome":{"co', peers: ['scanForIronOreBlocks'], sig: 'scanForIronOreBlocks:1qayo94:every call met its contract but the task outcome failed', defers: 3, notBefore: 1793987031290 },
    ],
    deferCounts: { 'scanForIronOreBlocks:callee_fix': 4, 'ensureFurnace:callee_fix': 1 },
};
describe('fix79 reset manifest (applied only after deploy)', () => {
    it('is a valid reset_bug_poisoned manifest and plans exactly the misroute stats + demotion on the live record', async () => {
        const { loadManifest, applyManifest } = await import('../scripts/reset_bug_poisoned.js');
        const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
        const m = loadManifest(new URL('../scripts/fix79_misroute_manifest.json', import.meta.url).pathname);
        const dir = mkdtempSync('/tmp/fix79-manifest-');
        try {
            mkdirSync(`${dir}/skills`);
            writeFileSync(`${dir}/skills/index.json`, JSON.stringify([LIVE]));
            writeFileSync(`${dir}/skills/progress.json`, JSON.stringify(LIVE_PROGRESS));
            const r = applyManifest({ manifest: m, botsDir: dir, apply: false, log: () => {} });
            assert.deepStrictEqual(r.changes.map(c => [c.target, c.before, c.after]), [
                ['scanForIronOreBlocks.stats.fail', 10, 0], ['scanForIronOreBlocks.stats.streakFail', 10, 0], ['scanForIronOreBlocks.demoted', true, false],
                ['deferredRepairs[1]', LIVE_PROGRESS.deferredRepairs[1], undefined], ['deferCounts.scanForIronOreBlocks:callee_fix', 4, undefined]]);
            writeFileSync(`${dir}/skills/index.json`, JSON.stringify([{ ...LIVE, stats: { ...LIVE.stats, fail: 11, streakFail: 11 } }]));
            assert.throws(() => applyManifest({ manifest: m, botsDir: dir, apply: false, log: () => {} }), /expect mismatch/, 'a further misroute before deploy refuses the stale count');
        } finally { rmSync(dir, { recursive: true }); }
    });
});
