/**
 * fix162 — ground truth decides, the critic advises (learning-investigation-20261121.md).
 *
 * Both ground-truth-false branches of the verdict chain (reach goal not observed, count goal
 * not met by inventory delta) previously returned the LLM critic's own success flag. Measured
 * on the 1401 labeled cases in bots/icefox2000/critic_cases.jsonl (label=false is recorded
 * ground truth): the critic overrode ground truth to success=true in 30 cases (2.14%) — e.g.
 * "Smelt 13 raw_iron into 13 iron_ingot", "Mine 10 stone", "reach iron_block" — and a
 * success=true verdict saves the skill (voyager.js saveSkill gate). Voyager checks completion
 * against game state, not model opinion (arXiv:2305.16414 §3.3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Voyager } from '../src/agent/voyager.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('fix162: _groundFalse makes ground truth decisive', () => {
    const withCritic = (verdict) => {
        const v = Object.create(Voyager.prototype);
        v.critique = async (task, before, after, output, label) => {
            assert.strictEqual(label, false, 'ground-truth cases must still be logged with label=false');
            return verdict;
        };
        return v;
    };
    it('forces success=false when the critic said true, keeping its critique', async () => {
        const v = withCritic({ success: true, reasoning: 'looked done', critique: 'smelt longer' });
        const out = await v._groundFalse('Smelt 13 raw_iron into 13 iron_ingot', {}, {}, '', 'inventory did not gain 13 iron_ingot');
        assert.strictEqual(out.success, false);
        assert.strictEqual(out.critique, 'smelt longer');
        assert.match(out.reasoning, /ground truth: inventory did not gain 13 iron_ingot/);
        assert.match(out.reasoning, /critic said true/);
    });
    it('passes a false critic verdict through unchanged in success and critique', async () => {
        const v = withCritic({ success: false, reasoning: 'no furnace', critique: 'place a furnace first' });
        const out = await v._groundFalse('Smelt 13 raw_iron', {}, {}, '', 'inventory did not gain 13 iron_ingot');
        assert.strictEqual(out.success, false);
        assert.strictEqual(out.critique, 'place a furnace first');
    });
    it('both labeled branches of the verdict chain route through _groundFalse', () => {
        const src = readFileSync(join(here, '..', 'src', 'agent', 'voyager.js'), 'utf8');
        assert.match(src, /reached === false \? await this\._groundFalse\(/);
        assert.match(src, /goal \? await this\._groundFalse\(/);
        // label=false appears in exactly one critique call - inside _groundFalse itself
        const labeledCalls = src.match(/await this\.critique\(task, before, after, output, false\)/g) || [];
        assert.strictEqual(labeledCalls.length, 1, 'only _groundFalse may call the critic on a labeled case');
        assert.doesNotMatch(src, /critique\(task, before, after, output, goal \?/);
    });
});
