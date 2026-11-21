// fix152: a library argument rejection must be blamed on the caller, not the library.
// Live (mindcraft.log 21 Nov): findSafeBlock learned code calls getNearestBlocks(bot, "concrete", ...) — "concrete" is not
// a block in the game data (coloured variants only, e.g. white_concrete; minecraft-data pc). fix95 fails that loudly, and
// fix70's blame attributes the throw to the library frame ("NO VERDICT ... not the skill's fault (stats unchanged)"), so
// findSafeBlock never took a failure, was never demoted and never reached PSN repair — 3312 faults, one per idle-practice
// retry. The fix: the library marks caller-argument rejections (world.js callerFault marker), the trace carries it
// (rec.errCallerFault) and voyager._libraryFault returns null for marked errors so stats/gate/PSN act on the skill.
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

let world, Voyager;

const botStub = () => ({
    registry: { blockLoot: {}, blocksByName: {} },
    findBlocks: () => [],
    blockAt: () => null,
});

before(async () => {
    const mc = await import('../src/utils/mcdata.js');
    mc._setVersionForTest('1.21.4');
    world = await import('../src/agent/library/world.js');
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
});

describe('fix152 caller-fault marker', () => {
    it('names a non-block name as a caller fault', () => {
        let err = null;
        try { world.getNearestBlocks(botStub(), 'concrete', 16, 1); } catch (e) { err = e; }
        assert.ok(err, 'getNearestBlocks must reject a name that is not a block');
        assert.match(err.message, /not a block in the game data/);
        assert.equal(err.callerFault, true);
    });

    it('names a scan argument that is not a number as a caller fault', () => {
        let err = null;
        try { world.getNearestBlocks(botStub(), 'stone', '16', 1); } catch (e) { err = e; }
        assert.ok(err, 'getNearestBlocks must reject a non-numeric distance');
        assert.match(err.message, /must be a finite number/);
        assert.equal(err.callerFault, true);
    });

    it('does not mark a real scan as a fault', () => {
        assert.deepEqual(world.getNearestBlocks(botStub(), 'stone', 5, 1), []);
    });

    it('_libraryFault defers to the marker: caller fault stays with the skill', () => {
        const self = { progress: {} };
        const trace = [{
            name: 'findSafeBlock',
            err: 'getNearestBlocks: "concrete" is not a block in the game data',
            errTop: 'at Object.getNearestBlocks (file:///Users/x/src/agent/library/world.js:235:23)',
            errCallerFault: true,
        }];
        assert.equal(Voyager.prototype._libraryFault.call(self, trace, 'findSafeBlock'), null);
        assert.equal(self.progress.libraryFaults, undefined, 'a caller fault must not be counted against the library');
    });

    it('_libraryFault still blames the library when nothing marks otherwise', () => {
        const self = { progress: {}, _saveProgress() { } };
        const trace = [{
            name: 'findSafeBlock',
            err: 'boom',
            errTop: 'at Object.getNearestBlocks (file:///Users/x/src/agent/library/world.js:235:23)',
        }];
        const w = Voyager.prototype._libraryFault.call(self, trace, 'findSafeBlock');
        assert.equal(w.fn, 'Object.getNearestBlocks');
        assert.ok(self.progress.libraryFaults['Object.getNearestBlocks file:///Users/x/src/agent/library/world.js:235:23'] === 1);
    });
});
