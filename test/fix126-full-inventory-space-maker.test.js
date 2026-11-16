/**
 * fix126 (live icefox2000, 12:26 GMT 16 Nov, after fix125 deploy): food 12/20 with a full
 * inventory (room for 0). urgent-need decomposed need:hunger into "Obtain 1 cod"; the queue
 * path took it and fix120's capacity gate rejected it ("inventory cannot hold 1 cod (room
 * for 0); free space first: propose tossClutter or depositToChest") — and the throw at the
 * take site failed the step, urgent-need re-queued the same plan, and every step repeated
 * the pair. The advice named the fix but nothing acted on it. A taken subgoal rejected for
 * physical capacity now queues the space-maker ahead of it and puts the subgoal back behind.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import Registry from 'prismarine-registry';
import { VitalsModel } from '../src/agent/vitals_model.js';
import { _setVersionForTest as loadMcData } from '../src/utils/mcdata.js';

const VER = '1.21.4';
let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
    loadMcData(VER);
});

function rigFull() {
    const v = Object.create(Voyager.prototype);
    v.skills = [];
    v.npGraph = null;
    v.progress = {
        subgoals: [{ task: 'Obtain 1 cod', parent: 'need:hunger', depth: 1 }],
        decomposed: { 'need:hunger': { subs: ['Obtain 1 cod'], skills: [], at: 1, reason: 'needs' } },
        decomposeQueue: null,
        completed: [], completedAt: {}, failed: [], blockers: [],
        goalStats: {}, goalFailStates: [], fix25: true, recipeEdges: {},
    };
    Object.defineProperty(v, '_decomposeQueue', {
        get() { return this.progress.decomposeQueue; },
        set(q) { this.progress.decomposeQueue = q; },
    });
    v.agent = {
        name: 'fix126',
        bot: {
            health: 20, food: 12,
            game: { maxHealth: 20, maxFood: 20 },
            interrupt_code: false,
            inventory: (() => {
                const slots = new Array(46).fill(null);
                for (let i = 9; i < 45; i++) slots[i] = { name: 'cobblestone', count: 64 };
                return { slots, inventoryStart: 9, inventoryEnd: 45, emptySlotCount: () => 0 };
            })(),
            registry: Registry(VER),
            entity: { position: { x: 0, y: 64, z: 0 } },
            version: VER,
            currentWindow: null,
        },
        openChat() {},
        actions: { executing: false },
    };
    v.vitals = new VitalsModel({ regen: {}, runs: {}, foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } } });
    v._curSub = null;
    v.currentTask = null;
    v._saveProgress = () => {};
    v._saveSkills = () => {};
    v._repairQueue = [];
    v._afterSuccess = () => {};
    v._serveUrgent = async () => false;
    for (const m of ['_checkHomeGround', '_watchWindows', '_watchDimension', '_oneshot', '_requeueDeferred', '_prefetchPlan']) v[m] = () => {};
    for (const m of ['_queueApiLintRepairs', '_gateTrial', '_backfillContracts', '_refactor', '_prune', '_generalise', '_split', '_retention', '_idlePractice']) v[m] = async () => false;
    v.observe = () => ({ inventory: { cobblestone: 2304 }, nearby_blocks: [], position: '0,64,0', time: 'day 0', food_value: 12 });
    v.pursued = [];
    v._pursueProposedTask = async (task) => { v.pursued.push(task); return false; };
    v.proposeTask = async () => { throw new Error('proposeTask should not run'); };
    return v;
}

describe('fix126: a capacity-rejected taken subgoal queues a space-maker ahead of it', () => {
    it('"Obtain 1 cod" with room for 0: no throw, space-maker first, cod kept behind it', async () => {
        const v = rigFull();
        await v._step();
        const q = v.progress.subgoals;
        assert.strictEqual(q.length, 2, `expected [space-maker, cod], got ${JSON.stringify(q.map(s => s.task))}`);
        assert.strictEqual(q[0].task, 'Free up inventory space');
        assert.strictEqual(q[1].task, 'Obtain 1 cod');
        assert.deepStrictEqual(v.pursued, [], 'the step ends after re-queueing; the next step runs the space-maker');
    });

    it('the space-maker itself is a runnable task (next step pursues it)', async () => {
        const v = rigFull();
        await v._step();
        await v._step();
        assert.deepStrictEqual(v.pursued, ['Free up inventory space']);
    });

    it('a second rejection does not stack duplicate space-makers', async () => {
        const v = rigFull();
        await v._step();           // queue: [space, cod]
        await v._step();           // pursues space; stub returns false (not pursued) -> cod stays
        await v._step();           // cod head again, still room 0
        const spaces = v.progress.subgoals.filter((s) => s.task === 'Free up inventory space');
        assert.strictEqual(spaces.length, 1, JSON.stringify(v.progress.subgoals.map((s) => s.task)));
    });
});
