/**
 * fix167 (learning-investigation-20261121 Q5; live icefox2000 22 Nov 2026 08:52Z): the curriculum
 * proposed "Wait for night cycle or mob spawn conditions if no targets are currently detected".
 * The stall detector killed it (waiting produces none of the four progress signals: new ground,
 * inventory, window, lit furnace), the critic failed it, 4 attempts burned — and the same intake
 * let "Confirm arrival at the safe coordinate and verify no hostiles ... stand still to allow
 * health reg" through. This bot verifies everything by world-state change (completion = learned
 * postcondition, progress = the stall signals). Voyager's task space is explore/collect/smelt/
 * craft/kill/build (arXiv:2305.16414 §A.2) verified by environment state feedback (§3.3), so a
 * change-free task is unverifiable by construction. validateTask now rejects a leading passive
 * verb, and the "use the X skill" wrapper form that produced the scanForHoglin twin family
 * (paper §3.2: composition happens by calling library functions inside new code, never as a new
 * skill whose body is a call).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateTask } from '../src/agent/voyager.js';
import { _setVersionForTest } from '../src/utils/mcdata.js';
_setVersionForTest('1.20.4');   // validateTask -> knownNames -> getAllItems needs the item lists (fix146 pattern)

describe('fix167: change-free tasks rejected at intake', () => {
    it('rejects the live waiting task', () => {
        assert.match(validateTask('Wait for night cycle or mob spawn conditions if no targets are currently detected'), /changes no world state/);
    });
    it('rejects the live confirm/stand-still task', () => {
        assert.match(validateTask('Confirm arrival at the safe coordinate and verify no hostiles are within 16 blocks, then stand still to allow health reg'), /changes no world state/);
    });
    it('rejects other passive leading verbs', () => {
        for (const t of ['Scan the area for husks', 'Check whether the furnace is lit', 'Observe the sky', 'Monitor the piglins', 'Stand near the hut', 'Watch for creepers']) {
            assert.match(validateTask(t), /changes no world state/, t);
        }
    });
    it('accepts world-changing tasks', () => {
        for (const t of ['Mine 5 birch_log', 'Craft 1 stone_pickaxe', 'ensure crafting_table', 'Walk to the town center', 'Kill 1 hoglin', 'Explore the nearest cave', 'Smelt 3 iron_ingot into 3 iron_ingot'.replace(' into 3 iron_ingot', ''), 'Build a 5x5 cobblestone floor next to the hut']) {
            assert.strictEqual(validateTask(t), null, t);
        }
    });
    it('is unaffected by camelCase skill names containing passive words', () => {
        assert.strictEqual(validateTask('safeScanHostiles'), null);
        assert.strictEqual(validateTask('verifySurvivalStatus'), null);
    });
});

describe('fix167b: "use the X skill" tasks are replays, not new tasks', () => {
    it('rejects the live wrapper subgoal form', () => {
        assert.match(validateTask("Use the 'scanAndConfirmHoglin30' skill to check for Hoglins within 30 blocks and log their coordinates"), /replay, not a new task/);
        assert.match(validateTask('use existing skill depositToChest'), /replay, not a new task/);
    });
    it('accepts tool usage that names no skill', () => {
        assert.strictEqual(validateTask('Use a stone_axe to chop oak_log'), null);
    });
});
