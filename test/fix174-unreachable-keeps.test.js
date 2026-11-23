// fix174: a goal whose decomposition found no reachable/perceived source must stop reserving
// scarce items. Live deadlock 23 Nov 2026 at y=33: pending "Collect 4 birch_planks" reserved
// birch_planks (idle-practice "would consume scarce" gate), which filtered out mineToSurface and
// restAndRecover — the only skills that could reach the surface where birch_planks' own source is.
// An unexecutable plan was starving the plan that would make it executable.
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
let Voyager;
before(async () => { Voyager = (await import('../src/agent/voyager.js')).Voyager; });

function mkV(progress, unreachable) {
    const v = Object.create(Voyager.prototype);
    Object.assign(v, {
        skills: [],
        progress,
        _producers: () => [],
        agent: { bot: {} },
        ...(unreachable ? { _unreachableGoals: new Set(unreachable) } : {}),
    });
    return v;
}

describe('fix174: unreachable goals hold no item reservations', () => {
    const progress = { failed: [], pending: ['Collect 4 birch_planks'] };

    it('a reachable pending goal still reserves its item (baseline)', () => {
        const v = mkV(progress, null);
        assert.ok(v._getPendingGoalItems().has('birch_planks'));
        assert.ok(v._publishItemKeeps().has('birch_planks'));
    });

    it('once decompose marks the goal unreachable, its keeps are released', () => {
        const v = mkV(progress, ['Collect 4 birch_planks']);
        assert.strictEqual(v._getPendingGoalItems().has('birch_planks'), false);
        assert.strictEqual(v._publishItemKeeps().has('birch_planks'), false);
    });

    it('only the unreachable goal is released; other pending goals keep their reservations', () => {
        const p2 = { failed: [], pending: ['Collect 4 birch_planks', 'Collect 8 cobblestone'] };
        const v = mkV(p2, ['Collect 4 birch_planks']);
        assert.strictEqual(v._getPendingGoalItems().has('birch_planks'), false);
        assert.ok(v._getPendingGoalItems().has('cobblestone'));
    });

    it('both decompose "no source" skip sites mark the goal, and a successful game-data decomposition clears the mark', () => {
        const marks = SRC.match(/\(this\._unreachableGoals \?\?= new Set\(\)\)\.add\(task\);/g) || [];
        assert.strictEqual(marks.length, 2, 'both no-source skip sites must mark the goal unreachable');
        assert.ok(SRC.includes('this._unreachableGoals?.delete(task);'), 'game-data decompose success clears the mark');
        const skipLogs = SRC.match(/goal marked unreachable, its item keeps are released/g) || [];
        assert.strictEqual(skipLogs.length, 2);
    });
});
