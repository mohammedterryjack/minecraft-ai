// fix93: model-call stalls, idle-practice admission, repair repeats, hunger backchain, backend refusal.
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { betaUncertainty, printedUncertainty, causalChanges, effectVerdict, practiceWorld } from '../src/agent/practice_rank.js';
import { inferenceTiming, formatOllamaTiming, hostAttribution } from '../src/models/inference_timing.js';
import { createInferenceCover } from '../src/agent/inference_cover.js';
import { repairRetrySuffix, repeatedRejection, builtInsCalled } from '../src/agent/repair_attempt.js';
import { voyagerCodingInstructions } from '../src/agent/prompt_cut.js';
import { edibleNames, entityDroppers, heldEdible, planFoodAcquisition, hungerDeficitClosed } from '../src/agent/food_backchain.js';
import { obtainPlanner } from '../src/agent/recipe_plan.js';
import { VitalsModel } from '../src/agent/vitals_model.js';
import { CodeModel } from '../src/models/code_model.js';
import {
    classifyBackendRefusal, latchDisconnect, applyDisconnect, authorizeBackendResume,
    launchdWouldRestart, parentExitForChild, wrapperPreservesStatus, EXIT_BACKEND_UNAVAILABLE,
} from '../src/process/backend_unavailable.js';

const REFUSAL = '§cConnect failed: AnnotatedConnectException\n§cfinishConnect(..) failed with error(-61): Connection refused: /127.0.0.1:25565';
const POLICY = { successfulExit: false };

function tick() { return new Promise(r => setImmediate(r)); }

describe('fix93 timing', () => {
    it('missing durations are unavailable and a remote host is not a local-memory diagnosis', () => {
        const timing = inferenceTiming({
            json: { prompt_eval_count: 10, eval_count: 2, prompt_eval_duration: 5e6, eval_duration: 1e6 },
            wallMs: 40,
            url: 'http://192.168.1.215:11434',
            meta: { kind: 'compose', requestId: 'compose#1', components: { system: 800, user: 200 } },
        });
        assert.strictEqual(timing.load.status, 'unavailable');
        assert.strictEqual(timing.total.status, 'unavailable');
        assert.strictEqual(timing.queue.status, 'unavailable');
        assert.strictEqual(timing.transport.status, 'unavailable');
        assert.strictEqual(timing.prompt.status, 'measured');
        assert.strictEqual(timing.host.attribution, 'remote-model-host');
        const line = formatOllamaTiming('qwen3', timing);
        assert.match(line, /load_ms=unavailable/);
        assert.match(line, /host=192.168.1.215/);
        assert.match(line, /components=system=800,user=200/);
        assert.doesNotMatch(line, /ram|memory/i);
        assert.strictEqual(hostAttribution('http://127.0.0.1:11434').attribution, 'local-process');
    });
    it('queue is server total minus measured phases, and transport is wall minus server total', () => {
        const timing = inferenceTiming({
            json: { load_duration: 1e6, prompt_eval_duration: 4e6, eval_duration: 2e6, total_duration: 10e6, prompt_eval_count: 3, eval_count: 1 },
            wallMs: 25,
            url: 'http://192.168.1.215:11434',
            meta: { kind: 'critic', requestId: 'critic#2', components: { system: 3, user: 4 } },
        });
        assert.strictEqual(timing.queue.ms, 3);
        assert.strictEqual(timing.transport.ms, 15);
        assert.match(formatOllamaTiming('qwen3', timing), /total_ms=10/);
    });
    it('the ollama log no longer coerces a missing duration to 0', () => {
        const src = readFileSync(new URL('../src/models/ollama.js', import.meta.url), 'utf8');
        assert.doesNotMatch(src, /prompt_eval_duration\s*\|\|/);
        assert.doesNotMatch(src, /total_duration\s*\|\|/);
        assert.doesNotMatch(src, /load_duration\s*\|\|/);
    });
    it('one practice controller covers overlapping waits and settles before a foreground claim', async () => {
        let starts = 0;
        let world = 0;
        const cover = createInferenceCover({
            start() {
                starts++;
                return new Promise(resolve => setImmediate(() => { world = starts; resolve(); }));
            },
            stop() {},
        });
        cover.enter(1);
        cover.enter(2);
        assert.strictEqual(cover.controllers(), 1);
        assert.strictEqual(cover.waits(), 2);
        await cover.leave();
        assert.strictEqual(cover.inflight(), true, 'a remaining wait keeps practice');
        await cover.claim();
        assert.strictEqual(world, 1, 'claim settles the practice that was in flight');
        world = 99;
        assert.strictEqual(world, 99, 'the foreground reads the world after settlement');
        cover.resume(3);
        assert.strictEqual(cover.controllers(), 2);
        assert.strictEqual(cover.inflight(), true);
        await cover.leave();
        assert.strictEqual(cover.inflight(), false);
        await assert.rejects(cover.leave(), /leave without enter/);
    });
    it('a practice failure fails the wait loudly', async () => {
        const cover = createInferenceCover({
            start() { return Promise.reject(new Error('practice bug')); },
            stop() {},
        });
        cover.enter(1);
        await assert.rejects(cover.leave(), /practice bug/);
    });
    it('composer and curriculum waits share one voyager controller', async () => {
        const mod = await import('../src/agent/voyager.js');
        const v = Object.create(mod.Voyager.prototype);
        let starts = 0;
        let releaseLocal, releaseCode, endPractice;
        v._startIdlePractice = () => { starts++; return new Promise(resolve => { endPractice = resolve; }); };
        v._stopIdlePractice = () => { if (endPractice) endPractice(); };
        v._overlapCpuMaintenance = () => {};
        v._local = () => ({ sendRequest: () => new Promise(r => { releaseLocal = r; }) });
        v.agent = { prompter: { code_model: { sendRequest: () => new Promise(r => { releaseCode = r; }) } } };
        const meta = { kind: 'curriculum', components: { system: 1, user: 1 } };
        const local = v._askLocal('s', 'u', meta);
        const code = v._ask('s', 'u', { kind: 'compose', components: { system: 2, user: 2 } });
        await tick();
        assert.strictEqual(starts, 1);
        assert.strictEqual(v._inferCover.controllers(), 1);
        releaseLocal('L');
        assert.strictEqual(await local, 'L');
        assert.strictEqual(v._inferCover.inflight(), true, 'the composer wait still holds practice');
        releaseCode('C');
        assert.strictEqual(await code, 'C');
        assert.strictEqual(v._inferCover.inflight(), false);
    });
    it('the code system prompt drops the redundant expansions and the unused library join', () => {
        const coding = JSON.parse(readFileSync(new URL('../profiles/mo_bot.json', import.meta.url), 'utf8')).coding;
        const prose = voyagerCodingInstructions(coding, 'icefox');
        assert.ok(prose.length < coding.length);
        for (const marker of ['$SELF_PROMPT', '$MEMORY', '$STATS', '$INVENTORY', '$CODE_DOCS', '$EXAMPLES']) {
            assert.ok(!prose.includes(marker), marker);
        }
        assert.match(prose, /icefox/);
        assert.throws(() => voyagerCodingInstructions('no placeholders', 'icefox'), /\$SELF_PROMPT/);
        const src = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
        assert.ok(!src.includes('this.skills.map(s => s.code).join'));
        assert.match(src, /voyagerCodingInstructions\(prompter\.profile\.coding/);
    });
    it('a repair prompt lists only the built-ins that skill calls', () => {
        const sigs = ['goToPosition(bot, x, y, z)', 'consume(bot, itemName="")', 'digDown(bot)'];
        const code = 'async function walk(bot) { await goToPosition(bot, 1, 2, 3); }';
        assert.deepStrictEqual(builtInsCalled(sigs, code), ['- goToPosition(bot, x, y, z) [built-in]']);
        assert.deepStrictEqual(builtInsCalled(sigs, 'async function idle(bot) { return; }'), []);
    });
    it('composer exhaustion uses the explicit code-model path and forwards the call meta', async () => {
        const seen = [];
        const primary = { model_name: 'paid', sendRequest: async () => { throw Object.assign(new Error('429 quota'), { status: 429 }); } };
        const fallback = { model_name: 'ollama-free', sendRequest: async (turns, system, meta) => { seen.push(meta); return 'code'; } };
        const cm = new CodeModel(primary, 1000, 'code-model', fallback);
        const meta = { kind: 'repair', requestId: 'repair#9', components: { system: 4, user: 5 } };
        assert.strictEqual(await cm.sendRequest([{ role: 'user', content: 'u' }], 's', meta), 'code');
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0], meta);
        await assert.rejects(new CodeModel(primary, 1000, 'code-model', null).sendRequest([], 's', meta), /429 quota/);
    });
});

describe('fix93 practice admission', () => {
    it('a finite Beta value can print as 0.0000 and is still not zero', () => {
        const u = betaUncertainty(5000, 5000);
        assert.ok(u > 0);
        assert.strictEqual(printedUncertainty(u), '0.0000');
    });
    it('already-met, ret-only, and no-gain runs do not become effect successes', () => {
        const same = { inventory: { cobblestone: 3 }, equipment: { hand: 'iron_axe' }, position: '1, 64, 1' };
        assert.deepStrictEqual(causalChanges({ before: same, after: { ...same, inventory: { cobblestone: 3 }, equipment: { hand: 'iron_axe' } }, traceRoot: { s0: { pos: { x: 1, y: 64, z: 1 }, eq: { heldItem: 'iron_axe' } }, s1: { pos: { x: 1, y: 64, z: 1 }, eq: { heldItem: 'iron_axe' } }, delta: {} } }), []);
        assert.strictEqual(effectVerdict(true, []).effect, null);
        const moved = causalChanges({ before: same, after: same, traceRoot: { s0: { pos: { x: 1, y: 64, z: 1 } }, s1: { pos: { x: 9, y: 64, z: 1 } }, delta: {} } });
        assert.ok(moved.some(c => c.kind === 'position'));
        assert.strictEqual(effectVerdict(true, moved).effect, true);
        const equipped = causalChanges({ before: same, after: same, traceRoot: { s0: { eq: { heldItem: null } }, s1: { eq: { heldItem: 'iron_axe' } }, delta: {} } });
        assert.ok(equipped.some(c => c.kind === 'equipment'));
        let success = 1, fail = 0;
        for (let i = 0; i < 5000; i++) {
            const ev = effectVerdict(true, []);
            if (ev.effect === true) success++;
            if (ev.effect === false) fail++;
        }
        assert.deepStrictEqual([success, fail], [1, 0]);
    });
    it('an already-true post is not practised; a useful uncertain skill outranks exhausted busywork', async () => {
        const mod = await import('../src/agent/voyager.js');
        mod._setVersionForTest('1.21.4');
        const skill = (name, post, extra = {}) => ({
            name, code: `async function ${name}(bot) { return true; }`, description: name, effects: [], consumes: {},
            stats: { success: extra.success === undefined ? 0 : extra.success, fail: extra.fail === undefined ? 0 : extra.fail },
            contract: { pre: 'c => c.pre.alive', post },
            ...extra,
        });
        const furnace = skill('ensureFurnaceInRange', 'c => c.ret && c.post.alive && c.pre.dim === c.post.dim', { success: 4000, fail: 4000 });
        const useful = skill('fetchLogs', 'c => c.delta.oak_log > 0', { effects: ['oak_log'] });
        const known = skill('knownWalk', 'c => c.post.alive && c.pre.dim === c.post.dim', { success: 3, fail: 1, causalEvidence: { success: 4, fail: 0 } });
        const v = Object.create(mod.Voyager.prototype);
        v.skills = [furnace, known, useful];
        v._unjudgeableNoted = new Set();
        v._unverifiedConsumesNoted = new Set();
        v.agent = { bot: { food: 20 } };
        v.progress = { failed: [], pending: ['Collect 2 oak_log'] };
        v._getPendingGoalItems = () => new Set(['oak_log']);
        v._producers = () => [];
        v.observe = () => ({
            inventory: {},
            alive: true,
            dimension: 'overworld',
            position: '0, 64, 0',
            equipment: { hand: 'empty', off_hand: 'empty', head: 'empty', torso: 'empty', legs: 'empty', feet: 'empty' },
        });
        assert.strictEqual(v._practicePostAlreadyMet(furnace, v.observe()).met, true);
        assert.strictEqual(practiceWorld(v.observe()).dim, 'overworld');
        assert.strictEqual(v._selectPracticeSkill(new Map()).name, 'fetchLogs');
        v._getPendingGoalItems = () => new Set();
        v.skills = [known, useful];
        useful.effects = [];
        assert.strictEqual(v._selectPracticeSkill(new Map()).name, 'fetchLogs', 'zero relevance does not let a known effect win, and an unknown effect still may');
        v.observe = () => ({ inventory: {} });
        const axe = skill('equipIronAxe', "c => c.post.eq.heldItem === 'iron_axe'");
        v.skills = [axe];
        assert.strictEqual(v._practicePostAlreadyMet(axe, { equipment: { hand: 'iron_axe' }, alive: true }).met, true);
        assert.strictEqual(v._practicePostAlreadyMet(axe, { equipment: { hand: 'empty' }, alive: true }).met, false);
    });
    it('a ret-only practice run and an unmet precondition leave effect stats unchanged', async () => {
        const mod = await import('../src/agent/voyager.js');
        mod._setVersionForTest('1.21.4');
        const { markPreconditionUnmet } = await import('../src/agent/precondition.js');
        const skill = {
            name: 'ensureFurnaceInRange',
            code: 'async function ensureFurnaceInRange(bot) { return true; }',
            description: 'd', effects: [], consumes: {},
            stats: { success: 4, fail: 1, streakFail: 0, tasks: [] },
            contract: { pre: 'c => c.pre.alive', post: 'c => c.ret && c.post.alive && c.pre.dim === c.post.dim' },
        };
        const pos = { x: 1, y: 64, z: 1 };
        const root = { name: skill.name, parent: -1, depth: 0, t0: 0, t1: 5, intr: false, rv: true, fail: false, argv: [], delta: {}, o0: 0, o1: 0, s0: { pos, alive: true, dim: 'overworld' }, s1: { pos, alive: true, dim: 'overworld' } };
        const bot = { interrupt_code: false, output: '', pathfinder: { stop() {} }, __psnTrace: [] };
        const v = Object.create(mod.Voyager.prototype);
        Object.assign(v, {
            skills: [skill], progress: {}, _saveSkills: () => {}, _idlePracticeActive: true,
            agent: { bot, isIdle: () => true, requestInterrupt: () => { bot.interrupt_code = true; } },
            _threats: () => 'none',
            observe: () => ({ inventory: { cobblestone: 1 }, equipment: { hand: 'empty' }, position: '1, 64, 1' }),
            _libSrcSubset: () => '', _closure: () => [], _timedBotForSkillRun: () => bot,
            _stageLintExecTraced: async () => ({ lint: null, staged: { func: { main: async b => { b.__psnTrace = [root]; } } } }),
        });
        v._armPracticeAbort();
        const r = await v._runPracticeSkill(skill);
        assert.strictEqual(r.ok, null, r.detail);
        assert.match(r.detail, /no causal state change/);
        assert.deepStrictEqual([skill.stats.success, skill.stats.fail], [4, 1]);
        const unmet = { ...skill, name: 'cook', contract: { pre: 'c => c.pre.alive', post: 'c => c.delta.coal > 0' } };
        v.skills = [unmet];
        v._saveProgress = () => {};
        v._stageLintExecTraced = async () => ({ lint: null, staged: { func: { main: async b => { markPreconditionUnmet(b, { need: { item: 'coal', count: 1, reason: 'input' } }); b.__psnTrace = [{ ...root, name: 'cook', s1: { pos: { x: 4, y: 64, z: 1 }, alive: true, dim: 'overworld' } }]; } } } });
        const u = await v._runPracticeSkill(unmet);
        assert.strictEqual(u.ok, null);
        assert.match(u.detail, /unmet precondition/);
        assert.deepStrictEqual([unmet.stats.success, unmet.stats.fail], [4, 1]);
    });
});

describe('fix93 repair retry', () => {
    it('the retry carries the rejected candidate and the exact reason, and a suggestion is not a rewrite', () => {
        const candidate = 'async function scan(bot) { const z = bot.getNearbyEntities(); __mcPreconditionUnmet__(bot, { need: { item: "sword", count: 1, reason: "input" } }); }';
        const reason = 'API gate: bot.getNearbyEntities does not exist on the live bot (closest real members: bot.nearestEntity)';
        const suffix = repairRetrySuffix({ candidate, reason, identity: 'abc', n: 1 });
        assert.match(suffix, /your previous reply was rejected/);
        assert.ok(suffix.includes(candidate));
        assert.ok(suffix.includes(reason));
        assert.ok(suffix.includes('__mcPreconditionUnmet__'));
        assert.ok(suffix.includes('bot.getNearbyEntities'));
        const repeated = repeatedRejection(
            { n: 1, candidate, reason, identity: 'abc' },
            { n: 2, candidate, identity: 'abc' },
        );
        assert.strictEqual(repeated.name, 'repeated-rejected-reply');
        assert.strictEqual(repeated.attempts.length, 2);
        assert.strictEqual(repeated.attempts[1].repeated, true);
        assert.strictEqual(repeatedRejection({ n: 1, candidate, reason, identity: 'abc' }, { n: 2, candidate: 'other', identity: 'def' }), null);
    });
});

function foodRegistry() {
    return {
        items: {
            1: { id: 1, name: 'wheat' },
            2: { id: 2, name: 'bread' },
            3: { id: 3, name: 'beef' },
        },
        itemsByName: {
            wheat: { id: 1, name: 'wheat' },
            bread: { id: 2, name: 'bread' },
            beef: { id: 3, name: 'beef' },
        },
        blocksByName: { wheat: { name: 'wheat', harvestTools: null } },
        blockLoot: { wheat: { drops: [{ item: 'wheat', silkTouch: false }] } },
        entityLoot: { cow: { entity: 'cow', drops: [{ item: 'beef', dropChance: 1 }] } },
        foodsByName: { bread: { name: 'bread', foodPoints: 5 }, beef: { name: 'beef', foodPoints: 3 } },
    };
}

describe('fix93 hunger backchain', () => {
    const registry = foodRegistry();
    const planner = (recipesOf = () => []) => obtainPlanner({
        registry, recipesOf, known: () => false, proven: () => false,
    });
    it('a held edible is eaten; a missing one is the cheapest game-data plan, including an entity drop', () => {
        assert.deepStrictEqual(heldEdible(edibleNames(registry), { bread: 2 }), ['bread']);
        const held = planFoodAcquisition({
            edibles: edibleNames(registry), inventory: { bread: 1 },
            cheapest: () => { throw new Error('must not plan when an edible is held'); },
            prerequisites: () => { throw new Error('must not plan when an edible is held'); },
            entityDroppersFor: () => [],
        });
        assert.strictEqual(held.executable, true);
        assert.strictEqual(held.item, 'bread');
        const p = planner(id => id === 2 ? [{ result: { count: 1 }, delta: [{ id: 1, count: -3 }, { id: 2, count: 1 }] }] : []);
        const missing = planFoodAcquisition({
            edibles: ['bread', 'beef'], inventory: {},
            cheapest: (items, count, inv) => p.cheapest(items, count, inv),
            prerequisites: (item, count, inv) => p.prerequisites(item, count, inv),
            entityDroppersFor: item => entityDroppers(registry, item),
        });
        assert.strictEqual(missing.executable, false);
        assert.strictEqual(missing.item, 'bread');
        assert.match(missing.task, /bread/);
        const beef = planFoodAcquisition({
            edibles: ['beef'], inventory: {},
            cheapest: (items, count, inv) => p.cheapest(items, count, inv),
            prerequisites: (item, count, inv) => p.prerequisites(item, count, inv),
            entityDroppersFor: item => entityDroppers(registry, item),
        });
        assert.deepStrictEqual(beef.entityDroppers, ['cow']);
        assert.strictEqual(hungerDeficitClosed(10, 19, 18).closed, true);
        assert.strictEqual(hungerDeficitClosed(10, 12, 18).closed, false);
        assert.throws(() => hungerDeficitClosed(10, 19, null), /learned regen floor/);
    });
    it('a missing tool is a nested step, and an unreachable graph throws', () => {
        const reg = {
            items: {
                1: { id: 1, name: 'wheat' }, 2: { id: 2, name: 'bread' },
                3: { id: 3, name: 'stone_pickaxe' }, 4: { id: 4, name: 'cobblestone' },
                8: { id: 8, name: 'ore' }, 9: { id: 9, name: 'missing_pick' },
            },
            itemsByName: {
                wheat: { id: 1, name: 'wheat' }, bread: { id: 2, name: 'bread' },
                stone_pickaxe: { id: 3, name: 'stone_pickaxe' }, cobblestone: { id: 4, name: 'cobblestone' },
                ore: { id: 8, name: 'ore' }, missing_pick: { id: 9, name: 'missing_pick' },
            },
            blocksByName: {
                wheat: { name: 'wheat', harvestTools: { 3: true } },
                cobblestone: { name: 'cobblestone', harvestTools: null },
                ore_block: { harvestTools: { 9: true } },
                deep: { harvestTools: { 9: true } },
            },
            blockLoot: {
                wheat: { drops: [{ item: 'wheat', silkTouch: false }] },
                cobblestone: { drops: [{ item: 'cobblestone', silkTouch: false }] },
                ore_block: { drops: [{ item: 'ore', silkTouch: false }] },
                deep: { drops: [{ item: 'missing_pick', silkTouch: false }] },
            },
            foodsByName: { bread: { name: 'bread' } },
        };
        const withTool = obtainPlanner({
            registry: reg,
            recipesOf: (id) => {
                if (id === 2) return [{ result: { count: 1 }, delta: [{ id: 1, count: -3 }, { id: 2, count: 1 }] }];
                if (id === 3) return [{ result: { count: 1 }, delta: [{ id: 4, count: -3 }, { id: 3, count: 1 }] }];
                return [];
            },
            known: () => false, proven: () => false,
        });
        const bread = planFoodAcquisition({
            edibles: ['bread'], inventory: {},
            cheapest: (items, count, inv) => withTool.cheapest(items, count, inv),
            prerequisites: (item, count, inv) => withTool.prerequisites(item, count, inv),
            entityDroppersFor: () => [],
        });
        assert.ok(bread.plan.some(step => step.includes('stone_pickaxe')), bread.plan.join(' | '));
        assert.ok(bread.plan.some(step => step.includes('cobblestone')), bread.plan.join(' | '));
        const stuck = obtainPlanner({ registry: reg, recipesOf: () => [], known: () => false, proven: () => false });
        assert.throws(() => planFoodAcquisition({
            edibles: ['ore'], inventory: {},
            cheapest: (items, count, inv) => stuck.cheapest(items, count, inv),
            prerequisites: (item, count, inv) => stuck.prerequisites(item, count, inv),
            entityDroppersFor: () => { throw new Error('unreachable plan must not ask for droppers'); },
        }), /LOUD|no acyclic|none of/);
    });
});

describe('fix93 hunger serve', () => {
    let Voyager;
    before(async () => {
        const mod = await import('../src/agent/voyager.js');
        Voyager = mod.Voyager;
        mod._setVersionForTest('1.21.4');
    });
    function mk(runs) {
        const v = Object.create(Voyager.prototype);
        const bot = {
            health: 20, food: 10, game: { dimension: 'overworld' },
            registry: foodRegistry(),
            inventory: { emptySlotCount: () => 10 },
            entity: { position: { x: 0, y: 64, z: 0 } },
        };
        v.agent = { bot, name: 'icefox', actions: { executing: false }, openChat() {}, fatal(msg) { throw new Error(msg); } };
        v.vitals = new VitalsModel({
            regen: { 18: { n: 14, up: 4 }, 20: { n: 14, up: 9 } },
            runs, foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } },
        });
        v.skills = [];
        v.progress = { subgoals: [{ task: 'Mine 1 iron_ore' }], decomposed: {}, failed: [], completed: [], blockers: [], goalStats: {}, recipeEdges: {} };
        v._saveProgress = () => {};
        v._saveSkills = () => {};
        v.currentTask = null;
        v._curSub = null;
        v._afterSuccess = () => { v._after = true; };
        v.observe = () => ({ inventory: v._inv, nearby_blocks: [] });
        v._inv = {};
        v.proposeTask = async () => { throw new Error('proposeTask must not cold-start a learned food effect'); };
        v._chainNeeds = (task, needs) => {
            v._chained = { task, needs };
            v.progress.subgoals.unshift({ task: 'Collect 1 bread' }, { task, retry: true, prereq: true });
            return true;
        };
        v._obtainPlanner = () => ({
            cheapest: () => ({ item: 'bread' }),
            prerequisites: () => ({ task: 'Craft 1 bread', how: 'craft', plan: ['Collect 3 wheat', 'Craft 1 bread'], cycles: [] }),
        });
        return v;
    }
    it('no library raiser backchains from the learned consume effect and keeps unrelated work', async () => {
        const v = mk({ consume: { n: 14, food: 46.2, hp: 0 } });
        assert.strictEqual(await v._serveUrgent(), true);
        assert.strictEqual(v._chained.task, 'need:hunger');
        assert.strictEqual(v._chained.needs[0].item, 'bread');
        assert.deepStrictEqual(v.progress.subgoals.map(s => s.task), ['Collect 1 bread', 'Mine 1 iron_ore']);
        assert.ok(!v.progress.subgoals.some(s => s.task === 'need:hunger'));
    });
    it('a held edible runs the raiser and closes on measured food, not on the item existing', async () => {
        const v = mk({ consume: { n: 14, food: 46.2, hp: 0 } });
        v._inv = { bread: 1 };
        v._consumeItem = async (item) => { v._ate = item; v.agent.bot.food = 19; return true; };
        assert.strictEqual(await v._serveUrgent(), true);
        assert.strictEqual(v._ate, 'bread');
        assert.strictEqual(v._after, true);
        assert.strictEqual(v._chained, undefined);
        v.agent.bot.food = 10;
        v._consumeItem = async () => { v.agent.bot.food = 12; return true; };
        await assert.rejects(v._serveUrgent(), /still below the learned floor/);
    });
    it('a playable library raiser does not acquire food first', async () => {
        const v = mk({ eatCookedMutton: { n: 4, food: 20, hp: 0 } });
        v.skills = [{ name: 'eatCookedMutton', demoted: false, mergedInto: null, stats: { success: 4, fail: 0 } }];
        v._replay = async (_label, _before, route) => { v._route = route.name; return { ok: true, name: route.name }; };
        assert.strictEqual(await v._serveUrgent(), true);
        assert.strictEqual(v._route, 'eatCookedMutton');
        assert.strictEqual(v._chained, undefined);
    });
    it('an unreachable plan fails loudly and does not drop the queue', async () => {
        const v = mk({ consume: { n: 2, food: 4, hp: 0 } });
        v._obtainPlanner = () => ({ cheapest: () => { throw new Error('[fix81] LOUD: none of bread can be obtained from the game data'); } });
        await assert.rejects(v._serveUrgent(), /LOUD: none of bread/);
        assert.deepStrictEqual(v.progress.subgoals.map(s => s.task), ['Mine 1 iron_ore']);
    });
});

describe('fix93 backend unavailable', () => {
    it('classifies the captured ViaProxy refusal and nothing broader', () => {
        const hit = classifyBackendRefusal('kicked', REFUSAL);
        assert.strictEqual(hit.kind, 'backend-unavailable');
        assert.strictEqual(classifyBackendRefusal('kicked', 'You are banned from this server'), null);
        assert.strictEqual(classifyBackendRefusal('kicked', 'Failed to verify username'), null);
        assert.strictEqual(classifyBackendRefusal('error', 'NativeIoException: Connection reset by peer: error(-54)'), null);
        assert.strictEqual(classifyBackendRefusal('kicked', 'kicked'), null);
        assert.strictEqual(classifyBackendRefusal('end', ''), null);
    });
    it('duplicate callbacks are one exit, the parent and wrapper keep it, and a crash still restarts', () => {
        const latch = { latched: false };
        const exits = [];
        applyDisconnect(latch, 'kicked', REFUSAL, code => exits.push(code));
        const again = applyDisconnect(latch, 'end', REFUSAL, code => exits.push(code));
        applyDisconnect(latch, 'error', new Error(REFUSAL), code => exits.push(code));
        assert.deepStrictEqual(exits, [EXIT_BACKEND_UNAVAILABLE]);
        assert.strictEqual(again.duplicate, true);
        assert.strictEqual(launchdWouldRestart(exits[0], POLICY), false);
        const child = parentExitForChild(0, null);
        assert.strictEqual(child.code, 0);
        assert.strictEqual(launchdWouldRestart(child.code, POLICY), false);
        const killed = parentExitForChild(null, 'SIGKILL');
        assert.strictEqual(killed.code, 1);
        assert.strictEqual(launchdWouldRestart(killed.code, POLICY), true);
        assert.strictEqual(parentExitForChild(1, null).code, 1);
        assert.strictEqual(launchdWouldRestart(parentExitForChild(1, null).code, POLICY), true);
        const script = readFileSync(new URL('../run-native.sh', import.meta.url), 'utf8');
        assert.strictEqual(wrapperPreservesStatus(script), true);
        const plist = readFileSync(new URL('../services/launchd/com.mo.icefox.plist', import.meta.url), 'utf8');
        assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
        assert.doesNotMatch(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
        assert.doesNotMatch(plist, /ThrottleInterval/);
        const doc = readFileSync(new URL('../services/launchd/README.md', import.meta.url), 'utf8');
        assert.match(doc, /not deployed|does not install/i);
    });
    it('an explicit resume clears the latch', () => {
        const latch = { latched: false };
        const exits = [];
        applyDisconnect(latch, 'kicked', REFUSAL, code => exits.push(code));
        authorizeBackendResume(latch);
        assert.strictEqual(latch.latched, false);
        applyDisconnect(latch, 'kicked', REFUSAL, code => exits.push(code));
        assert.deepStrictEqual(exits, [0, 0]);
        assert.throws(() => authorizeBackendResume({ latched: false }), /latched backend-unavailable/);
        const other = { latched: false };
        applyDisconnect(other, 'kicked', 'You are banned', code => exits.push(code));
        assert.strictEqual(exits.at(-1), 1);
        assert.strictEqual(latchDisconnect(other, 'end', 'socket hang up').duplicate, true);
    });
});
