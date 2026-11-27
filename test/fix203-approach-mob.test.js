/**
 * fix203: generic approachMob seeded primitive + routing.
 * Live evidence (Nov 25): "Kill 1 zombie" -> approach zombie had no route, so the PSN planner invented prose
 * subgoals ("Move the bot's position directly toward the nearest hostile entity...") that the coder built from
 * scratch; 4 attempts burned ~8 min of standing in the open at night and the bot died to phantoms. Every mob
 * type grew its own bespoke approachX skill (approachCod, approachHoglin, approachZombie), each re-deriving
 * the same hostile scan. approachMob gives "approach <mob>" (the fix141 canonical task) one structured route.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

let Voyager, setVersion;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    setVersion = mod._setVersionForTest;
    setVersion('1.20.4');
});

const prim = () => Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'approachMob');

function vec(x, y, z) {
    return { x, y, z, floored() { return vec(Math.floor(x), Math.floor(y), Math.floor(z)); },
        distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); },
        clone() { return vec(this.x, this.y, this.z); } };
}

function mkBot(entities) {
    const bot = {
        entity: { position: vec(0, 64, 0) },
        interrupt_code: false,
        nearestEntity(pred) {
            let best = null, bd = Infinity;
            for (const e of entities) {
                const d = e.position.distanceTo(bot.entity.position);
                if (d < bd && pred(e)) { best = e; bd = d; }
            }
            return best;
        },
    };
    return bot;
}

function runPrim(bot, mobType, { goToPosition, preconditionUnmet }) {
    const logs = [];
    const fn = new Function('bot', 'mobType', 'log', 'goToPosition', '__mcPreconditionUnmet__',
        `${prim().code}; return approachMob(bot, mobType);`);
    return { promise: fn(bot, mobType, m => logs.push(String(m)), goToPosition, preconditionUnmet), logs };
}

describe('fix203 approachMob primitive', () => {
    it('is seeded with the presence-window description and no deps', () => {
        const p = prim();
        assert.ok(p, 'approachMob must be in SEEDED_PRIMITIVES');
        assert.ok(/48 blocks/.test(p.description), 'description states the presence window');
    });

    it('throws loudly on a non-string mobType', async () => {
        const bot = mkBot([]);
        const { promise } = runPrim(bot, undefined, { goToPosition: async () => true, preconditionUnmet: () => { throw new Error('must not stamp'); } });
        await assert.rejects(promise, /mobType must be an entity name string/);
    });

    it('absent mob: stamps the fix141 approach need and returns false', async () => {
        const bot = mkBot([{ name: 'zombie', position: vec(200, 64, 0) }]);   // outside 48
        const stamps = [];
        const { promise } = runPrim(bot, 'zombie', {
            goToPosition: async () => { throw new Error('must not move when absent'); },
            preconditionUnmet: (_b, ev) => stamps.push(ev),
        });
        assert.strictEqual(await promise, false);
        assert.strictEqual(stamps.length, 1);
        assert.deepStrictEqual(stamps[0].need, { item: 'zombie', count: 1, reason: 'approach' });
    });

    it('mob at 30 blocks: closes and returns true', async () => {
        const mob = { name: 'zombie', position: vec(30, 64, 0) };
        const bot = mkBot([mob]);
        const calls = [];
        const { promise } = runPrim(bot, 'zombie', {
            goToPosition: async (_b, x, _y, _z, reach) => { calls.push([x, reach]); bot.entity.position = vec(x - reach, 64, 0); return true; },
            preconditionUnmet: () => { throw new Error('must not stamp when the mob is present'); },
        });
        assert.strictEqual(await promise, true);
        assert.strictEqual(calls.length, 1, 'one closing move toward the mob');
    });

    it('mob already within 8: true without moving', async () => {
        const bot = mkBot([{ name: 'cod', position: vec(5, 64, 0) }]);
        const { promise } = runPrim(bot, 'cod', {
            goToPosition: async () => { throw new Error('must not move'); },
            preconditionUnmet: () => { throw new Error('must not stamp'); },
        });
        assert.strictEqual(await promise, true);
    });

    it('unreachable mob (no progress): false after 3 tries, no stamp', async () => {
        const mob = { name: 'phantom', position: vec(40, 80, 0) };
        const bot = mkBot([mob]);
        let moves = 0;
        const { promise } = runPrim(bot, 'phantom', {
            goToPosition: async () => { moves++; return false; },   // bot never moves
            preconditionUnmet: () => { throw new Error('mob is present: this is an approach failure, not a location need'); },
        });
        assert.strictEqual(await promise, false);
        assert.strictEqual(moves, 3);
    });

    it('interrupt stops the approach', async () => {
        const bot = mkBot([{ name: 'zombie', position: vec(30, 64, 0) }]);
        bot.interrupt_code = true;
        const { promise } = runPrim(bot, 'zombie', {
            goToPosition: async () => { throw new Error('must not move after interrupt'); },
            preconditionUnmet: () => {},
        });
        assert.strictEqual(await promise, false);
    });
});

describe('fix203 routing and contract', () => {
    function mk(skills) {
        const v = Object.create(Voyager.prototype);
        v.skills = skills.map(s => JSON.parse(JSON.stringify(s)));
        v.progress = { completedAt: {}, completed: [], failed: [], goalStats: {}, fix25: true, refactors: {} };
        v.npGraph = { consumesOf: () => ({}), getProducersOf: () => [], getRequirementsOf: () => [], recordDelta: () => {} };
        v._saveProgress = () => {};
        v._saveSkills = () => {};
        v._maturity = () => ({ V: 0.5 });
        return v;
    }
    const approachMobSkill = {
        name: 'approachMob', task: 'Approach the nearest mob of the given entity type (within 48 blocks); returns true once within 8 blocks of it.',
        deps: [], effects: [], consumes: {},
        code: 'async function approachMob(bot, mobType) { return true; }', stats: { success: 1, fail: 0, tasks: [] },
    };

    it('"approach zombie" routes to approachMob(bot, "zombie")', () => {
        const v = mk([approachMobSkill]);
        const r = v._structuredReplay('approach zombie');
        assert.ok(r, '"approach zombie" must route once the primitive exists');
        assert.strictEqual(r.name, 'approachMob');
        assert.strictEqual(r.call, 'await approachMob(bot, "zombie");');
    });

    it('a non-mob target does not route (approachGoal rejects it)', () => {
        const v = mk([approachMobSkill]);
        assert.strictEqual(v._structuredReplay('approach cobblestone'), null);
    });

    it('without the skill no route is invented', () => {
        const v = mk([]);
        assert.strictEqual(v._structuredReplay('approach zombie'), null);
    });

    it('the route carries the mob presence contract (pre=mob, count 1)', () => {
        const c = Voyager.prototype._contract({ name: 'approachMob', call: 'await approachMob(bot, "zombie");' });
        assert.deepStrictEqual(c, { mob: 'zombie', count: 1, pre: 'mob' });
    });
});
