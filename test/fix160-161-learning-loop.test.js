/**
 * fix160/fix161 — learning-loop root causes (learning-investigation-20261121.md).
 *
 * fix160: PSN decompose emitted one-shot micro-subgoals pinned to the bot's current spot
 * ("Move one block west to align X coordinate to -175", live mindcraft.log), they became
 * tasks, and successes saved as skills: 87 of 1012 skill files are coordinate-fixed.
 * Voyager keeps motion-at-coordinates as function arguments, never library entries
 * (arXiv:2305.16414 §3.1-3.2). subgoalOverfit rejects them at intake; the decompose
 * prompt now says so.
 *
 * fix161: Voyager's library is keyed by the description embedding (paper §3.2); saveSkill
 * wrote new files for descriptions already in the library — measured today: 62 live pairs
 * at cosine >= 0.98 (many exactly 1.0000). duplicateSkillMatch gates that.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { subgoalOverfit, duplicateSkillMatch } from '../src/agent/voyager.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('fix160: subgoalOverfit rejects coordinate-pinned subgoals', () => {
    const rejected = [
        'Move one block west to align X coordinate to -175',
        'Move one block east to (-175, 40, 101) to exit the stalled coordinate',
        'Navigate horizontally to intermediate waypoint (-145, 76, 97) using safe travelTo logic',
        'Ascend vertically from current Y=26 to Y=31 by placing blocks below',
        'Use travelTo to move from current position to (-173, 41, 105), stopping if Y < 30',
    ];
    for (const t of rejected) {
        it(`rejects: ${t.slice(0, 60)}...`, () => assert.ok(subgoalOverfit(t), 'should be rejected'));
    }
    const accepted = [
        'Craft a stone pickaxe',
        'Collect 5 cobblestone',
        'Equip the best sword',
        'Smelt iron ore into iron ingots',
        'Approach the nearest hoglin',
    ];
    for (const t of accepted) {
        it(`accepts: ${t}`, () => assert.strictEqual(subgoalOverfit(t), null));
    }
    it('the decompose prompt teaches generality', () => {
        const src = readFileSync(join(here, '..', 'src', 'agent', 'voyager.js'), 'utf8');
        assert.match(src, /never put absolute coordinates, current positions, or current counts in a subgoal/);
    });
});

describe('fix161: duplicateSkillMatch gates description-keyed re-learns', () => {
    const v = (a, b) => [a, b, 0];
    it('matches a live skill at cosine >= 0.98', () => {
        const skills = [{ name: 'verifySurvivalStatus', embedding: v(1, 0) }];
        assert.strictEqual(duplicateSkillMatch(skills, v(0.999, 0.01))?.name, 'verifySurvivalStatus');
    });
    it('does not match below the threshold', () => {
        const skills = [{ name: 'tossPinkPetals', embedding: v(1, 0) }];
        assert.strictEqual(duplicateSkillMatch(skills, v(1, 0.35)), null);   // cos ~0.944
    });
    it('ignores demoted and merged entries and mismatched embedding lengths', () => {
        assert.strictEqual(duplicateSkillMatch([{ name: 'a', demoted: true, embedding: v(1, 0) }], v(1, 0)), null);
        assert.strictEqual(duplicateSkillMatch([{ name: 'a', mergedInto: 'b', embedding: v(1, 0) }], v(1, 0)), null);
        assert.strictEqual(duplicateSkillMatch([{ name: 'a', embedding: [1, 0, 0, 0] }], v(1, 0)), null);
    });
    it('tolerates entries without embeddings (re-embedded by retrieveSkills)', () => {
        assert.strictEqual(duplicateSkillMatch([{ name: 'a' }, { name: 'b', embedding: v(1, 0) }], v(1, 0))?.name, 'b');
    });
    it('saveSkill routes new saves through the gate, comparing only fresh embeddings (fix163)', () => {
        const src = readFileSync(join(here, '..', 'src', 'agent', 'voyager.js'), 'utf8');
        assert.match(src, /const dup = duplicateSkillMatch\(this\.skills\.filter\(s => s\._embHash && s\._embHash === this\._embHash\(s\)\), embedding\);/);
        assert.match(src, /entry\._embHash = this\._embHash\(entry\);/);
    });
});
