/**
 * fix60 (live iMac 2026-11-06, after rejoin at 11:09:30 GMT at (-124.5, 40.0, 60.5)): craftRecipe(iron_pickaxe) failed 16x with
 * "no line of sight to crafting table at (-125, 43, 61)" while "You have reached at -125, 43, 61" was logged first.
 * Root cause: the seeded craftRecipe walked with goToPosition(GoalNear, 3 blocks) and only then tested bot.canSeeBlock; GoalNear is
 * satisfied in the tunnel under the table (distance only), so no step ever moved the bot to a spot that can see the table.
 * Fix: goToReachBlock walks with mineflayer-pathfinder's GoalLookAtBlock (game reach, the bot's real eye height) and verifies a ray
 * from the real eye reaches a face; fails loud when no such spot is reachable.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { readFileSync } from 'fs';
import pf from 'mineflayer-pathfinder';
import Registry from 'prismarine-registry';
import PWorld from 'prismarine-world';
import PChunk from 'prismarine-chunk';
import Vec3 from 'vec3';
import { canReachBlock, goToReachBlock } from '../src/agent/library/skills.js';
import { blameAll } from '../src/agent/skill_graph.js';
import { nearestBotMember } from '../src/agent/coder.js';
import { Ollama } from '../src/models/ollama.js';

const registry = Registry('1.20.4');
const Chunk = PChunk(registry), World = PWorld(registry);
const TABLE = new Vec3(-125, 43, 61);
// live geometry: bot in a 2-high tunnel at (-125, 40..41, 60), table at (-125, 43, 61), solid rock around
function liveWorld({ shaft = false, approach = false } = {}) {
    const w = new World(null).sync;
    for (let cx = -9; cx <= -7; cx++) for (let cz = 2; cz <= 4; cz++) w.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
    const stone = registry.blocksByName.stone.defaultState, air = registry.blocksByName.air.defaultState;
    for (let x = -129; x <= -121; x++) for (let y = 38; y <= 46; y++) for (let z = 54; z <= 66; z++) w.setBlockStateId(new Vec3(x, y, z), stone);
    const carve = (x, y, z) => w.setBlockStateId(new Vec3(x, y, z), air);
    carve(-125, 40, 60); carve(-125, 41, 60);
    if (shaft) { carve(-125, 42, 60); carve(-125, 43, 60); }
    if (approach) for (let z = 56; z <= 59; z++) { carve(-125, 40, z); carve(-125, 41, z); }
    w.setBlockStateId(TABLE, registry.blocksByName.crafting_table.defaultState);
    return w;
}
function mockBot(world, feet, pathfinder) {
    return {
        registry, world, output: '', interrupt_code: false,
        entity: { position: feet.clone(), eyeHeight: 1.62 },
        inventory: { items: () => [] },
        canSeeBlock(block) {   // mineflayer's own implementation (blocks.js)
            const headPos = this.entity.position.offset(0, this.entity.eyeHeight, 0);
            const range = headPos.distanceTo(block.position);
            const dir = block.position.offset(0.5, 0.5, 0.5).minus(headPos);
            const match = (b, iter) => !!iter.intersect(b.shapes, b.position) || block.position.equals(b.position);
            const hit = this.world.raycast(headPos, dir.normalize(), range, match);
            return !!hit && hit.position.equals(block.position);
        },
        pathfinder,
    };
}
const noPath = { setMovements() {}, stop() {}, getPathTo: async () => ({ status: 'noPath' }), goto: async () => { throw new Error('No path to the goal!'); } };

describe('fix60: craft path moves to a spot with line of sight to the table', () => {
    it('reproduces the live state: in the tunnel under the table the table is neither seen nor reachable', () => {
        const bot = mockBot(liveWorld(), new Vec3(-124.5, 40, 60.5), noPath);
        const table = bot.world.getBlock(TABLE);
        assert.strictEqual(bot.canSeeBlock(table), false, 'mineflayer canSeeBlock is false here, as in the live log');
        assert.strictEqual(canReachBlock(bot, table), false);
        // the old walk goal: GoalNear(table, 3) accepts a node in this tunnel, so the old path never moved
        const near = new pf.goals.GoalNear(TABLE.x, TABLE.y, TABLE.z, 3);
        assert.strictEqual(near.isEnd(new Vec3(-125, 41, 60)), true, 'GoalNear(3) is satisfied by distance only');
        assert.strictEqual(canReachBlock({ ...bot, entity: { position: new Vec3(-124.5, 41, 60.5), eyeHeight: 1.62 } }, table), false, 'no face visible from the tunnel spot GoalNear accepts');
    });

    it('fails loudly when no spot with sight and reach is reachable', async () => {
        const bot = mockBot(liveWorld(), new Vec3(-124.5, 40, 60.5), noPath);
        const ok = await goToReachBlock(bot, bot.world.getBlock(TABLE));
        assert.strictEqual(ok, false);
        assert.match(bot.output, /FAILED: no reachable spot with line of sight to crafting_table at \(-125, 43, 61\)/);
    });

    it('walks with GoalLookAtBlock (library reach, bot eye height) and ends where a face is in sight', async () => {
        const goals = [];
        const world = liveWorld({ shaft: true, approach: true });
        let bot;
        const pathfinder = {
            setMovements() {}, stop() {},
            getPathTo: async (m, goal) => { goals.push(goal); return { status: 'success' }; },
            // move to the first air node (feet+head air, solid below) that the goal accepts
            goto: async (goal) => {
                for (let z = 56; z <= 60; z++) for (let y = 40; y <= 42; y++) {
                    const n = new Vec3(-125, y, z);
                    if (world.getBlock(n).name === 'air' && world.getBlock(n.offset(0, 1, 0)).name === 'air' && world.getBlock(n.offset(0, -1, 0)).name !== 'air' && goal.isEnd(n)) { bot.entity.position = n.offset(0.5, 0, 0.5); return; }
                }
                throw new Error('No path to the goal!');
            },
        };
        bot = mockBot(world, new Vec3(-124.5, 40, 56.5), pathfinder);
        const table = world.getBlock(TABLE);
        assert.strictEqual(canReachBlock(bot, table), false, 'starts out of sight');
        const ok = await goToReachBlock(bot, table);
        assert.strictEqual(ok, true, bot.output);
        assert.ok(goals[0] instanceof pf.goals.GoalLookAtBlock, 'walk goal is a GoalLookAtBlock, not GoalNear');
        assert.strictEqual(goals[0].entityHeight, bot.entity.eyeHeight, 'uses the bot eye height');
        assert.strictEqual(goals[0].reach, new pf.goals.GoalLookAtBlock(TABLE, world).reach, 'reach is the library survival reach, not ours');
        assert.strictEqual(canReachBlock(bot, table), true);
    });

    it('already in sight: no walk at all', async () => {
        const bot = mockBot(liveWorld({ shaft: true }), new Vec3(-124.5, 41, 60.5), { ...noPath, getPathTo: async () => { throw new Error('should not path'); } });
        assert.strictEqual(await goToReachBlock(bot, bot.world.getBlock(TABLE)), true);
    });

    it('seeded craftRecipe and library craftRecipe/smelt use goToReachBlock, no distance-only walk or magic distances', () => {
        const v = readFileSync('./src/agent/voyager.js', 'utf8');
        const a = v.indexOf("name: 'craftRecipe'"), b = v.indexOf('deps:', a), seed = v.slice(a, b);
        assert.ok(seed.includes('goToReachBlock(bot, craftingTable)'));
        assert.ok(!seed.includes('goToPosition(bot, craftingTable'), 'no GoalNear walk to the table');
        assert.ok(!/dist > 4|canSeeBlock/.test(seed));
        const s = readFileSync('./src/agent/library/skills.js', 'utf8');
        const reach = s.slice(s.indexOf('async function _reachBlock'), s.indexOf('export async function collectBlock'));
        assert.ok(!/reach: 3|GoalNear|catch \(e\) \{\}/.test(reach), '_reachBlock has no reach:3, GoalNear fallback or empty catch');
        assert.ok(!s.includes('distanceTo(craftingTable.position) > 3.5'));
        assert.ok(!s.includes('distanceTo(furnaceBlock.position) > 3.5'));
    });
});

describe('fix60: a library-owned failure is not blamed on the learned callers', () => {
    // live trace (11:09-11:20 GMT): craftOneIronPickaxe > craftItem > craftRecipe, craftRecipe's precondition held
    const trace = () => [
        { name: 'craftOneIronPickaxe', parent: -1, depth: 0, ok: false, fail: true, ownFail: [], ret: 'false' },
        { name: 'craftItem', parent: 0, depth: 1, ok: false, fail: true, ownFail: [], ret: 'false' },
        { name: 'craftRecipe', parent: 1, depth: 2, ok: false, fail: true, ownFail: ['FAILED: craftRecipe(iron_pickaxe) no line of sight to crafting table at (-125, 43, 61)'], ret: 'false' },
    ];
    const isLeaf = () => false, isLearned = () => true;
    it('precondition held -> only craftRecipe is blamed (callers met its contract)', () => {
        const t = trace(); t[2].preHeld = true;
        const bs = blameAll(t, isLeaf, isLearned);
        assert.deepStrictEqual(bs.map(b => [b.target, b.kind]), [['craftRecipe', 'callee_fix']]);
    });
    it('no contract evidence -> old behaviour (callers caller_fix)', () => {
        const bs = blameAll(trace(), isLeaf, isLearned);
        assert.deepStrictEqual(bs.map(b => b.target), ['craftRecipe', 'craftItem', 'craftOneIronPickaxe']);
    });
    it('a caller with its own FAILED line is still blamed', () => {
        const t = trace(); t[2].preHeld = true; t[1].ownFail = ['FAILED: craftItem gave up'];
        assert.deepStrictEqual(blameAll(t, isLeaf, isLearned).map(b => b.target), ['craftRecipe', 'craftItem']);
    });
    it('_checkContracts marks preHeld when the precondition evaluates true', () => {
        const v = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(v.includes("if (ok !== false) { if (k === 'pre') r.preHeld = true; continue; }"));
    });
});

describe('fix60: API gate names the closest real bot member (reflected, no list)', () => {
    class Base { equip() {} unequip() {} activateItem() {} }
    const bot = Object.assign(new Base(), { heldItem: null, usingHeldItem: false, entity: {}, entities: {}, inventory: {}, findBlocks() {}, findBlock() {} });
    it('bot.equippedItem -> bot.heldItem first', () => {
        assert.strictEqual(nearestBotMember(bot, 'equippedItem', false)[0], 'heldItem');
    });
    it('calls prefer callable members (inherited ones included)', () => {
        assert.strictEqual(nearestBotMember(bot, 'findBlocksNear', true)[0], 'findBlocks');
        assert.strictEqual(nearestBotMember(bot, 'equipItem', true)[0], 'equip');
    });
    it('getters are classified without being invoked', () => {
        const g = {}; Object.defineProperty(g, 'heldItem', { get() { throw new Error('getter ran'); }, enumerable: true });
        assert.strictEqual(nearestBotMember(g, 'equippedItem', false)[0], 'heldItem');
    });
    it('gate message carries the suggestion', () => {
        assert.ok(readFileSync('./src/agent/coder.js', 'utf8').includes('closest real members: ${nearestBotMember(bot, n.property.name'));
    });
});

describe('fix60: Ollama calls have no implicit undici header/body timeout', () => {
    it('uses a dedicated dispatcher with headersTimeout/bodyTimeout disabled', () => {
        const s = readFileSync('./src/models/ollama.js', 'utf8');
        assert.ok(s.includes('new Agent({ headersTimeout: 0, bodyTimeout: 0 })'));
        assert.ok(s.includes('fetch(request, bound.ms !== null ? { dispatcher: OLLAMA_DISPATCHER, signal: AbortSignal.timeout(bound.ms) } : { dispatcher: OLLAMA_DISPATCHER })'));
    });
    it('a slow reply (headers sent only when generation ends) still arrives', async () => {
        const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ embeddings: [[1, 2]], prompt_eval_count: 1, total_duration: 3e8, load_duration: 0 })); }, 300)); });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        const o = new Ollama('m', `http://127.0.0.1:${srv.address().port}`, {});
        const v = await o.embed('x');
        srv.close();
        assert.deepStrictEqual(v, [1, 2]);
    });
});

describe('fix60: a hung Ollama call is cut by a learned bound, never silently', () => {
    const serve = (delay) => new Promise(r => { const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { if (delay < 0) return; setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ embeddings: [[1]], prompt_eval_count: 1, total_duration: 1e6, load_duration: 0 })); }, delay); }); }); srv.listen(0, '127.0.0.1', () => r(srv)); });
    it('unbounded (loud) until a call with reply counters is learned; then rates scaled to the request (fix63)', async () => {
        const cd = await import('../src/models/call_durations.js');
        const store = {}; cd.setCallDurationStore(store);
        const shape = { chars: 40, genBudget: () => 0 };
        assert.strictEqual(cd.callBound('m /api/embed', shape).ms, null);
        cd.recordCall('m /api/embed', 100, 40, { pTok: 10, pMs: 80, gTok: 0, gMs: 0 });   // 4 chars/tok, 8 ms/tok, 20 ms other
        assert.strictEqual(cd.callBound('m /api/embed', shape).ms, 20 + 8 * 10);
        assert.strictEqual(cd.callBound('m /api/embed', { chars: 400, genBudget: () => 0 }).ms, 20 + 8 * 100, 'a 10x larger request gets a 10x larger work term');
    });
    it('a server that never answers is aborted loudly at the learned bound, and the cut widens the next bound', async () => {
        const cd = await import('../src/models/call_durations.js');
        const store = {}; cd.setCallDurationStore(store);
        const fast = await serve(20), hang = await serve(-1);
        const a = new Ollama('hm', `http://127.0.0.1:${fast.address().port}`, {});
        await a.embed('x'); Object.assign(store['hm /api/embed'], { cpt: 1, pRate: 50, over: 60 });   // learned: 1 char/tok, 50 ms/tok, 60 ms other -> 'x' = 110 ms
        const b = new Ollama('hm', `http://127.0.0.1:${hang.address().port}`, {});
        const t0 = Date.now();
        await assert.rejects(b.embed('x'), e => e.code === 'OLLAMA_LEARNED_BOUND' && /learned bound 110ms/.test(e.message));
        assert.ok(Date.now() - t0 < 5000, 'cut near the learned bound, not after an implicit library timeout');
        assert.ok(cd.callBound('hm /api/embed', { chars: 1, genBudget: () => 0 }).ms >= Date.now() - t0 - 50, 'censored observation widens the next bound');
        fast.close(); hang.closeAllConnections(); hang.close();
    });
    it('sendRequest rethrows the learned-bound abort instead of a canned reply', () => {
        assert.ok(readFileSync('./src/models/ollama.js', 'utf8').includes("if (err.code === 'OLLAMA_LEARNED_BOUND') throw err;"));
        assert.ok(readFileSync('./src/agent/voyager.js', 'utf8').includes('setCallDurationStore(this.progress.callDurations)'));
    });
});
