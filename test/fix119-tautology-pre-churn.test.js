/**
 * fix119 (live icefox2000, 15 Nov 2026, 18:17-19:45 GMT):
 * A. tossDeepslate30 had learned post "c => true". Every successful toss ("Discarded 30
 *    cobbled_deepslate") was then unverifiable for the fix56 open-goal check ("post reads
 *    only [], nothing the run produced") -> replay judged FAILED -> "task failed after 4
 *    attempts: Toss 30 cobbled_deepslate", repeatedly, while the inventory stayed full.
 *    _validContract accepted the tautology; the same judgment now runs at learn time.
 * B. idle-practice re-picked tossAllTorches every window (18:17-19:45): its learned pre
 *    "c => c.pre.alive && (c.pre.inv.torch || 0) > 0" was false (no torches), so every
 *    run was NO VERDICT by fix87's own rule ("pre did not hold... stats unchanged"),
 *    and the unchanged stats kept it the top candidate forever.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
});

function rig() {
    const v = Object.create(Voyager.prototype);
    v.agent = { name: 'testbot' };
    return v;
}

describe('fix119 A: _validContract refuses a post that reads nothing the run produces', () => {
    it('rejects post "c => true" (the stored tossDeepslate30 case)', () => {
        const bad = rig()._validContract({ pre: 'c => true', post: 'c => true', text: 'tautology' }, null);
        assert.ok(bad, 'tautological post must be refused');
        assert.match(String(bad), /reads only/);
    });
    it('rejects post "() => true" (no parameter at all)', () => {
        const bad = rig()._validContract({ pre: 'c => true', post: '() => true', text: 'no param' }, null);
        assert.ok(bad, 'parameterless post must be refused');
    });
    it('rejects a post that reads only c.pre (state before proves nothing about the run)', () => {
        const bad = rig()._validContract({ pre: 'c => true', post: 'c => c.pre.alive', text: 'pre only' }, null);
        assert.ok(bad);
        assert.match(String(bad), /reads only \[pre\]/);
    });
    it('accepts a post that reads the run (delta)', () => {
        const bad = rig()._validContract(
            { pre: 'c => (c.pre.inv.torch || 0) > 0', post: 'c => c.delta.torch < 0 || !c.ret', text: 'toss' }, null);
        assert.strictEqual(bad, null, `expected acceptance, got: ${bad}`);
    });
});

describe('fix119 B: practice selection does not pick a skill whose learned pre is false', () => {
    const pre = 'c => c.pre.alive && (c.pre.inv.torch || 0) > 0';
    const post = 'c => c.delta.torch < 0 || !c.ret';
    function skill() {
        return {
            name: 'tossAllTorches', primitive: false, handwritten: false,
            code: 'async function tossAllTorches(bot) { await bot.tossStack(bot.inventory.items()[0]); }',
            stats: { success: 1, fail: 0, lastRun: 0 }, effects: [], consumes: [], needs: [],
            contract: { pre, post, text: 'toss torches' },
        };
    }
    function selectRig(obsInventory) {
        const v = rig();
        v.skills = [skill()];
        v.progress = { failed: [], pending: [] };
        v._unjudgeableNoted = new Set();
        v.observe = () => ({
            position: '1, 64, 1', health: '20/20', food: '20/20',
            health_value: 20, food_value: 20, alive: true, dimension: 'overworld',
            inventory: obsInventory, empty_inventory_slots: 10,
            equipment: { hand: 'empty', off_hand: 'empty', head: 'empty', torso: 'empty', legs: 'empty', feet: 'empty' },
        });
        return v;
    }
    it('_practicePreHolds: false when the bot holds no torches', () => {
        const v = selectRig({ cobblestone: 64 });
        const r = v._practicePreHolds(v.skills[0], v.observe());
        assert.strictEqual(r.holds, false);
        assert.match(r.reason, /pre does not hold in the current world/);
    });
    it('_practicePreHolds: true when the bot holds torches', () => {
        const v = selectRig({ torch: 12, cobblestone: 64 });
        const r = v._practicePreHolds(v.skills[0], v.observe());
        assert.strictEqual(r.holds, true);
    });
    it('_practicePreHolds: null (not a skip) when pre reads c.args', () => {
        const v = rig();
        const s = skill(); s.contract.pre = 'c => (c.pre.inv[c.args[0]] || 0) > 0';
        const r = v._practicePreHolds(s, { inventory: {} });
        assert.strictEqual(r.holds, null);
    });
    it('select: tossAllTorches is NOT picked with no torches (live: picked every window 18:17-19:45)', () => {
        const v = selectRig({ cobblestone: 64 });
        const picked = v._selectPracticeSkill(new Map());
        assert.strictEqual(picked, null);
    });
    it('select: with torches in hand it is still eligible (pre is a skip for now, not a mark)', () => {
        const v = selectRig({ torch: 12 });
        const picked = v._selectPracticeSkill(new Map());
        assert.ok(picked && picked.name === 'tossAllTorches');
    });
});
