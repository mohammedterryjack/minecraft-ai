// fix100: a hunger serve must not scan goalStats per plan node, and a block that covers the
// server's keep-alive kick must be killed with an inspector stack even when a heartbeat is
// younger than the kick bound.
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createServer, connect } from 'node:net';
import { edibleNames } from '../src/agent/food_backchain.js';
import { Coder } from '../src/agent/coder.js';
import { KEEP_ALIVE_INTERVAL_MS, KEEP_ALIVE_KICK_MS, watchdogBeatPeriodMs } from '../src/utils/event_loop_guard.js';

const require = createRequire(import.meta.url);
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);
const { Recipe } = require('prismarine-recipe')(registry);

const CHILD = fileURLToPath(new URL('./fixtures/fix100-keepalive-block-child.mjs', import.meta.url));
const NATIVE_CHILD = fileURLToPath(new URL('./fixtures/fix100-native-block-child.mjs', import.meta.url));
const HEALTHY_CHILD = fileURLToPath(new URL('./fixtures/fix100-healthy-then-block-child.mjs', import.meta.url));
const DEAD_WORKER_CHILD = fileURLToPath(new URL('./fixtures/fix100-dead-worker-exit-child.mjs', import.meta.url));
const CRASH_EXIT_CHILD = fileURLToPath(new URL('./fixtures/fix100-worker-crash-exit-child.mjs', import.meta.url));
const TERMINATE_EXIT_CHILD = fileURLToPath(new URL('./fixtures/fix100-terminate-exit-child.mjs', import.meta.url));
const FRESH_HEARTBEAT_CHILD = fileURLToPath(new URL('./fixtures/fix103-fresh-heartbeat-child.mjs', import.meta.url));
const START_AFTER_KEEPALIVE_MS = 13_000;
const BLOCK_MS = 20_000;
const INV = { oak_log: 23, diorite: 105, andesite: 60, raw_copper: 8, iron_helmet: 3, raw_iron: 85, torch: 80, oak_sapling: 18, granite: 64, coal: 15, stick: 1, cobbled_deepslate: 5, dark_oak_planks: 1, oak_button: 1, jukebox: 1, iron_sword: 1, music_disc_11: 1, honey_block: 1, cobblestone: 337, netherrack: 1, dirt: 261, birch_log: 6, oak_planks: 1 };
// e334ec8, this fixture, cheapest of every edible: about 22_000 plan() expansions and 21_637 smelt lookups.
// b4bd499 planned every furnace input on every branch: 2_849_202 expansions and 2_645_827 smelt lookups.
const MAIN_PLAN_EXPANSIONS = 22000;
const MAIN_SMELT_GETS = 21637;

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
});

function smeltOracle(goalStats) {
    const byItem = new Map();
    for (const [key, st] of Object.entries(goalStats)) {
        if (!(st.success > 0)) continue;
        const m = key.split('::')[0].match(/^(?:smelt|cook)\s+(\d+)\s+([a-z_]+)\s+into\s+(\d+)\s+([a-z_]+)/i);
        if (!m) continue;
        const input = m[2].toLowerCase();
        const item = m[4].toLowerCase();
        if (input === item) continue;
        let inputs = byItem.get(item);
        if (inputs === undefined) { inputs = []; byItem.set(item, inputs); }
        if (!inputs.includes(input)) inputs.push(input);
    }
    return byItem;
}

function history(n, items) {
    const goalStats = {};
    for (let i = 0; i < n; i++) {
        const name = items[i % items.length];
        goalStats[`Collect ${i % 5} ${name}::FAILED: reason text number ${i}`] = { success: i % 5 === 0 ? 1 : 0, fail: 1 };
    }
    const a = items[0], b = items[1], c = items[2], d = items[3], e = items[4], f = items[5];
    goalStats[`Smelt 1 ${a} into 1 ${a}::`] = { success: 4, fail: 0 };
    goalStats[`Smelt 1 ${b} into 1 ${c}::`] = { success: 0, fail: 3 };
    goalStats[`Cook 2 ${d} into 2 ${e}::`] = { success: 1, fail: 0 };
    goalStats[`Smelt 1 ${f} into 1 ${e}::later`] = { success: 2, fail: 0 };
    const recipeEdges = {};
    for (let i = 0; i < 69; i++) {
        const name = items[i];
        recipeEdges[name] = { task: `Collect 1 ${name}`, status: 'failed', runs: 5, fails: 2 };
    }
    return { goalStats, recipeEdges };
}

function indexLists(index) {
    const out = new Map();
    for (const [item, inputs] of index) out.set(item, [...inputs]);
    return out;
}

describe('fix100 planner', () => {
    it('one smelt scan per planner, and the hunger serve does not grow with goalStats', { timeout: KEEP_ALIVE_KICK_MS }, () => {
        const items = Object.keys(registry.itemsByName).filter(n => /^[a-z0-9_]+$/.test(n)).sort();
        const foods = edibleNames(registry);
        assert.ok(foods.length >= 40);
        const runs = [];
        for (const n of [1080, 5000]) {
            for (const feasible of n === 1080 ? [false, true] : [false]) {
                const { goalStats, recipeEdges } = history(n, items);
                let scans = 0;
                const proxied = new Proxy(goalStats, { ownKeys(t) { scans++; return Reflect.ownKeys(t); } });
                let recipeCalls = 0, edgeCalls = 0, smeltGets = 0;
                const v = Object.create(Voyager.prototype);
                v.agent = { bot: { version: VER, registry, recipesAll: (id) => { recipeCalls++; return Recipe.find(id); }, inventory: { emptySlotCount: () => 1 } } };
                v.skills = [];
                v.progress = { subgoals: [], decomposed: {}, failed: [], completedAt: {}, completed: [], blockers: [], recipeEdges, goalStats: proxied, goalFailStates: [] };
                v._saveProgress = () => {};
                v._producers = () => [];
                const origIndex = v._learnedSmeltIndex.bind(v);
                v._learnedSmeltIndex = () => {
                    const map = origIndex();
                    const origGet = map.get.bind(map);
                    map.get = (key) => { smeltGets++; return origGet(key); };
                    return map;
                };
                const origEdge = v._edgeSuccess.bind(v);
                v._edgeSuccess = (item, verb) => { edgeCalls++; return origEdge(item, verb); };
                const state = { inventory: { ...INV }, nearby_blocks: [] };
                const t0 = performance.now();
                const planner = v._obtainPlanner(state);
                const built = performance.now() - t0;
                const scansAtBuild = scans;
                const t1 = performance.now();
                const choice = planner.cheapest(foods, 1, { ...INV }, feasible);
                const cheapMs = performance.now() - t1;
                const scansAfter = scans;
                const indexed = indexLists(origIndex());
                const planCalls = planner.planCalls();
                runs.push({ n, feasible, item: choice.item, scansAtBuild, scansAfter, smeltGets, planCalls, recipeCalls, edgeCalls, built, cheapMs, indexed });
                console.log(`[fix100] N=${n} feasible=${feasible} build ${built.toFixed(1)}ms cheapest ${cheapMs.toFixed(1)}ms scans ${scansAtBuild}->${scansAfter} plans ${planCalls} smeltGets ${smeltGets} recipes ${recipeCalls} edgeSuccess ${edgeCalls} item ${choice.item}`);
            }
        }
        const small = runs.find(r => r.n === 1080 && r.feasible === false);
        const big = runs.find(r => r.n === 5000 && r.feasible === false);
        const reachable = runs.find(r => r.n === 1080 && r.feasible === true);
        assert.strictEqual(small.scansAtBuild, 1);
        assert.strictEqual(big.scansAtBuild, 1);
        assert.strictEqual(small.scansAfter, 1, 'cheapest rescanned goalStats');
        assert.strictEqual(big.scansAfter, 1, 'cheapest rescanned goalStats');
        assert.strictEqual(small.smeltGets, big.smeltGets);
        assert.ok(small.smeltGets > 0);
        assert.strictEqual(small.recipeCalls, big.recipeCalls);
        assert.strictEqual(small.edgeCalls, big.edgeCalls);
        assert.strictEqual(small.item, big.item);
        assert.deepStrictEqual(small.indexed, smeltOracle(history(1080, items).goalStats));
        assert.deepStrictEqual(big.indexed, smeltOracle(history(5000, items).goalStats));
        assert.deepStrictEqual(small.indexed, big.indexed);
        assert.strictEqual(small.planCalls, big.planCalls);
        assert.ok(small.planCalls <= MAIN_PLAN_EXPANSIONS, `feasible=false plan() ${small.planCalls} above main's ${MAIN_PLAN_EXPANSIONS}`);
        assert.ok(small.smeltGets <= MAIN_SMELT_GETS, `feasible=false smeltGets ${small.smeltGets} above main's ${MAIN_SMELT_GETS}`);
        assert.ok(reachable.planCalls <= MAIN_PLAN_EXPANSIONS, `feasible=true plan() ${reachable.planCalls} above main's ${MAIN_PLAN_EXPANSIONS}`);
        assert.ok(reachable.smeltGets <= MAIN_SMELT_GETS, `feasible=true smeltGets ${reachable.smeltGets} above main's ${MAIN_SMELT_GETS}`);
        assert.strictEqual(small.item, 'carrot');
        assert.strictEqual(reachable.item, 'beef');
        assert.strictEqual(reachable.scansAtBuild, 1);
        assert.strictEqual(reachable.scansAfter, 1);
    });
});

describe('fix100 craft reroute', () => {
    function craftBot() {
        return { version: VER, findBlock: () => null, recipesFor: () => [], inventory: { emptySlotCount: () => 4 }, food: 20 };
    }
    function skill(name, effects) {
        return { name, effects, demoted: false, deps: [], code: `async function ${name}(bot, item, count) { return false; }` };
    }
    function replayVoyager(effects) {
        const v = Object.create(Voyager.prototype);
        v.agent = { bot: craftBot(), openChat() {} };
        v.skills = [skill('craftItem', ['bread']), skill('obtainItem', effects)];
        v.npGraph = { confirmedProduces() { return []; } };
        v.observe = () => ({ inventory: {} });
        v.vitals = null;
        let staged = null;
        v._stageLintExecTraced = async (_lint, _exec, _names, label) => { staged = label; throw new Error('STOP_AFTER_REROUTE'); };
        return { v, staged: () => staged };
    }
    const call = { name: 'craftItem', call: 'await craftItem(bot, "bread", 1);' };

    it('does not reroute a failed craft when obtainItem has no learned evidence for the item', async () => {
        const { v, staged } = replayVoyager([]);
        const rp = await v._replay('Craft 1 bread', {}, call);
        assert.strictEqual(staged(), null);
        assert.strictEqual(rp.ok, false);
        assert.strictEqual(rp.name, 'craftItem');
        assert.strictEqual(rp.needs.length, 1);
        assert.strictEqual(rp.needs[0].item, 'bread');
        assert.strictEqual(rp.needs[0].count, 1);
        assert.strictEqual(rp.needs[0].reason, 'ingredients');
    });

    it('reroutes a failed craft when the target is learned to produce the item', async () => {
        const { v, staged } = replayVoyager(['bread']);
        await assert.rejects(() => v._replay('Craft 1 bread', {}, call), /STOP_AFTER_REROUTE/);
        assert.strictEqual(staged(), 'voyager:replay:obtainItem');
    });
});

describe('fix100 event-loop phases', () => {
    it('a setImmediate from an I/O callback does not run a due timer', async () => {
        // timers run before poll. setImmediate is the check phase of the same iteration, so a due
        // setInterval does not run between the socket callback and the setImmediate continuation.
        let beats = 0;
        const timer = setInterval(() => { beats++; }, 1);
        const srv = createServer();
        try {
            await new Promise((resolve) => srv.listen(0, resolve));
            const port = srv.address().port;
            const seen = await new Promise((resolve, reject) => {
                srv.on('connection', (socket) => {
                    socket.on('data', async () => {
                        const spun = performance.now();
                        while (performance.now() - spun < 5) { /* the interval is due; this does not yield */ }
                        const before = beats;
                        await new Promise((r) => { setImmediate(r); });
                        socket.destroy();
                        c.destroy();
                        srv.close();
                        resolve(beats > before);
                    });
                });
                const c = connect(port, '127.0.0.1', () => c.write('x'));
                c.on('error', (err) => { assert.fail(`client socket error: ${err && err.stack ? err.stack : err}`); });
                srv.on('error', reject);
            });
            assert.strictEqual(seen, false);
        } finally {
            clearInterval(timer);
        }
    });
});

describe('fix100 staging size', () => {
    it('logs the staged source size before and after the guards', async () => {
        const coder = new Coder({ name: 'fix100-stage-log' });
        const lines = [];
        const orig = console.log;
        console.log = (...args) => { lines.push(args.map(String).join(' ')); };
        try {
            await coder._stageCode('await bot.chat("hi");\nreturn;\n', { lintOnly: true });
        } finally {
            console.log = orig;
        }
        const pre = lines.find((l) => l.includes('pre-guard staged_source='));
        const post = lines.find((l) => l.includes('post-guard staged_source='));
        assert.ok(pre, lines.join('\n'));
        assert.ok(post, lines.join('\n'));
        const preN = Number(pre.match(/staged_source=(\d+)/)[1]);
        const postN = Number(post.match(/staged_source=(\d+)/)[1]);
        assert.ok(postN > preN, `pre-guard ${preN} post-guard ${postN}`);
        await rm(join(process.cwd(), 'bots', 'fix100-stage-log'), { recursive: true, force: true });
    });
});

describe('fix100 watchdog', () => {
    it('a 20s block starting 13s after a keep-alive is killed with its stack', { timeout: KEEP_ALIVE_KICK_MS + KEEP_ALIVE_INTERVAL_MS }, async () => {
        assert.ok(START_AFTER_KEEPALIVE_MS < KEEP_ALIVE_INTERVAL_MS);
        assert.ok(BLOCK_MS < KEEP_ALIVE_KICK_MS);
        assert.ok(START_AFTER_KEEPALIVE_MS + BLOCK_MS > KEEP_ALIVE_KICK_MS);
        const dir = await mkdtemp(join(tmpdir(), 'fix100-ka-'));
        const ev = join(dir, 'watchdog_kill.json');
        const child = spawn(process.execPath, [CHILD, ev], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        const ended = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
        assert.strictEqual(ended.signal, 'SIGKILL', stderr);
        assert.match(stderr, /MAIN THREAD BLOCKED/);
        assert.doesNotMatch(stderr, /KEEP-ALIVE NOT PROCESSED/);
        assert.match(stderr, /limit 30000ms/);
        assert.match(stderr, /keep-alive/);
        assert.match(stderr, /blockedInHungerServe/);
        assert.match(stderr, /finished /);
        assert.doesNotMatch(stderr, /stack not captured/);
        const recorded = JSON.parse(readFileSync(ev, 'utf8'));
        assert.strictEqual(recorded.killClock, 'keep-alive');
        assert.ok(recorded.silentMs >= KEEP_ALIVE_INTERVAL_MS, `heartbeat age ${recorded.silentMs}ms is still inside the beat interval`);
        assert.ok(recorded.silentMs < KEEP_ALIVE_KICK_MS, `heartbeat age ${recorded.silentMs}ms reached the beat kill`);
        assert.ok(recorded.kaAgeMs >= KEEP_ALIVE_KICK_MS, `ka age ${recorded.kaAgeMs}`);
        assert.ok(recorded.kaAgeMs < START_AFTER_KEEPALIVE_MS + BLOCK_MS, `killed after the block would have ended (${recorded.kaAgeMs}ms)`);
        assert.ok(Array.isArray(recorded.callFrames));
        assert.ok(recorded.callFrames.some(f => f.functionName === 'blockedInHungerServe'));
        assert.strictEqual(recorded.code.label, 'voyager:stage-exec');
        assert.strictEqual(typeof recorded.code.endedAt, 'string');
        assert.strictEqual(Object.hasOwn(recorded.code, 'source'), false);
        assert.strictEqual(recorded.lastPopped, 'action:hunger-serve');
        assert.strictEqual(typeof recorded.lastPoppedAt, 'string');
        assert.strictEqual(existsSync(ev), true);
        await rm(dir, { recursive: true, force: true });
    });

    it('a keep-alive kill with a heartbeat younger than the beat interval is KEEP-ALIVE NOT PROCESSED', { timeout: KEEP_ALIVE_KICK_MS + KEEP_ALIVE_INTERVAL_MS }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'fix103-fresh-ka-'));
        const ev = join(dir, 'watchdog_kill.json');
        const child = spawn(process.execPath, [FRESH_HEARTBEAT_CHILD, ev], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        const ended = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
        assert.strictEqual(ended.signal, 'SIGKILL', stderr);
        assert.match(stderr, /KEEP-ALIVE NOT PROCESSED/);
        assert.doesNotMatch(stderr, /MAIN THREAD BLOCKED/);
        const recorded = JSON.parse(readFileSync(ev, 'utf8'));
        assert.strictEqual(recorded.killClock, 'keep-alive');
        assert.ok(recorded.silentMs < KEEP_ALIVE_INTERVAL_MS, `heartbeat age ${recorded.silentMs}ms is not under the beat interval`);
        assert.ok(recorded.kaAgeMs >= KEEP_ALIVE_KICK_MS, `ka age ${recorded.kaAgeMs}`);
        await rm(dir, { recursive: true, force: true });
    });

    it('a native block is killed at the keep-alive deadline with stack not captured', { timeout: KEEP_ALIVE_KICK_MS + KEEP_ALIVE_INTERVAL_MS }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'fix100-native-'));
        const ev = join(dir, 'watchdog_kill.json');
        const child = spawn(process.execPath, [NATIVE_CHILD, ev], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        const ended = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
        assert.strictEqual(ended.signal, 'SIGKILL', stderr);
        assert.match(stderr, /stack not captured/);
        assert.doesNotMatch(stderr, /native block ended/);
        const recorded = JSON.parse(readFileSync(ev, 'utf8'));
        assert.strictEqual(recorded.killClock, 'keep-alive');
        assert.strictEqual(recorded.callFrames, 'stack not captured');
        assert.ok(recorded.kaAgeMs >= KEEP_ALIVE_KICK_MS, `ka age ${recorded.kaAgeMs}`);
        assert.ok(recorded.kaAgeMs < KEEP_ALIVE_KICK_MS + KEEP_ALIVE_INTERVAL_MS, `ran the whole native block (${recorded.kaAgeMs}ms)`);
        await rm(dir, { recursive: true, force: true });
    });

    it('healthy keep-alives older than half the limit do not spend the capture', { timeout: KEEP_ALIVE_KICK_MS * 3 }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'fix100-healthy-'));
        const ev = join(dir, 'watchdog_kill.json');
        const child = spawn(process.execPath, [HEALTHY_CHILD, ev], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        const ended = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
        assert.strictEqual(ended.signal, 'SIGKILL', stderr);
        assert.match(stderr, /laterRealBlock/);
        const recorded = JSON.parse(readFileSync(ev, 'utf8'));
        assert.strictEqual(recorded.killClock, 'keep-alive');
        assert.ok(Array.isArray(recorded.callFrames));
        assert.strictEqual(recorded.callFrames[0].functionName, 'laterRealBlock');
        await rm(dir, { recursive: true, force: true });
    });

    it('process.exit does not wait for a worker that has already exited', { timeout: watchdogBeatPeriodMs() }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'fix100-dead-'));
        const ev = join(dir, 'watchdog_kill.json');
        const child = spawn(process.execPath, [DEAD_WORKER_CHILD, ev], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        const ended = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
        assert.strictEqual(ended.signal, null, stderr);
        assert.strictEqual(ended.code, 0, stderr);
        assert.match(stderr, /LOUD: process.exit with the watchdog worker already exited/);
        await rm(dir, { recursive: true, force: true });
    });

    it('a worker crash exits through uncaughtException and fatal instead of waiting for an ack', { timeout: watchdogBeatPeriodMs() }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'fix100-crash-'));
        const ev = join(dir, 'watchdog_kill.json');
        const child = spawn(process.execPath, [CRASH_EXIT_CHILD, ev], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        const ended = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
        assert.strictEqual(ended.signal, null, stderr);
        assert.strictEqual(ended.code, 1, stderr);
        assert.match(stderr, /\[fatal\]/);
        // The worker writes this before it dies, on both the parent 'error' path and the 'exit'-only path.
        assert.match(stderr, /LOUD FAIL: worker fatal:/);
        assert.match(stderr, /TypeError: Cannot read properties of null \(reading 'gen'\)/);
        await rm(dir, { recursive: true, force: true });
    });

    it('terminate and process.exit in the same tick do not wait for an ack', { timeout: watchdogBeatPeriodMs() }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'fix100-term-'));
        const ev = join(dir, 'watchdog_kill.json');
        const child = spawn(process.execPath, [TERMINATE_EXIT_CHILD, ev], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        const ended = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
        assert.strictEqual(ended.signal, null, stderr);
        assert.strictEqual(ended.code, 0, stderr);
        assert.match(stderr, /LOUD: process.exit with the watchdog worker terminated/);
        await rm(dir, { recursive: true, force: true });
    });
});
