/**
 * fix195 (live iMac, 2026-11-26): embedding replay was dead. Log 26 Nov:
 *   [replay] embedding match for "Toss 25 cobblestone...": toss30CobblestoneTask score 0.944 (learned threshold 0.980) -> code model
 * progress.json carried replayThreshold=0.98 — the fix28 ratchet (+0.02 per replay failure, -0.01 per success,
 * cap 0.99) had saturated near its ceiling. Real matches score 0.90-0.94, so every task fell through to the code
 * model: ~30 near-duplicate toss_* skills, a 600-skill catalogue, 80-120 s curriculum calls and 250-skill idle
 * enumerations. Voyager blames the retrieved skill on replay failure, never a global bar
 * (arXiv:2305.16291 §2 Method); this codebase already does per-route blame (_recordRun -> s.stats -> rate()
 * scaling -> DEMOTE at streakFail>=3, plus fix186 proven-disjoint pair refusal). fix195 fixes the gate at 0.85
 * (fix28's original default) and removes the ratchet, so a stale progress file cannot keep replay dead.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
});

// A voyager whose only live collaborators are the embedding and the goal/fit checks _embedReplay uses.
function rig(staleThreshold, skillSim, skillStats) {
    const v = Object.create(Voyager.prototype);
    v.progress = { replayThreshold: staleThreshold };
    const q = [1, 0];
    v._embed = async () => q;
    v._resolveGoal = () => ({ kind: 'none' });
    v._routeProducesFit = () => true;
    v.skills = [{
        name: 'toss30CobblestoneTask', task: 'Toss 30 cobblestone', primitive: false, demoted: false,
        code: 'async function toss30CobblestoneTask(bot) {}',
        embedding: [skillSim, Math.sqrt(1 - skillSim * skillSim)],
        stats: skillStats || { success: 10, fail: 0, streakFail: 0, tasks: [] },
    }];
    return v;
}

describe('fix195 embedding replay gate is fixed; a saturated progress threshold cannot kill replay', () => {
    it('a 0.944 match replays even though progress.replayThreshold is 0.98 (the live poisoned value)', async () => {
        const v = rig(0.98, 0.944);
        const r = await v._embedReplay('Toss 25 cobblestone to free up inventory space');
        assert.ok(r && r.name === 'toss30CobblestoneTask', '0.944 >= the fixed 0.85 floor must replay, not hit the code model');
        assert.strictEqual(v.progress.replayThreshold, 0.98, 'the gate does not read or write the stale field');
    });
    it('a below-floor match still goes to the code model', async () => {
        const v = rig(0.85, 0.6);
        const r = await v._embedReplay('Toss 25 cobblestone');
        assert.strictEqual(r, null);
    });
    it('the global ratchet is gone: no _learnReplayThreshold on the prototype', () => {
        assert.strictEqual(typeof Voyager.prototype._learnReplayThreshold, 'undefined');
    });
    it('a failing route is not charged a global bar (no replayThreshold write anywhere in voyager.js)', async () => {
        const { readFileSync } = await import('fs');
        const src = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
        assert.ok(!/progress\.replayThreshold\s*(=|\+=)/.test(src), 'voyager.js must not write the global threshold');
        assert.ok(!/_learnReplayThreshold\s*\(/.test(src), 'no call sites of the removed ratchet');
    });
});
