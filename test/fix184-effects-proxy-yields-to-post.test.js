// fix184: the fix42 effects heuristic must not veto a skill whose contract post can be evaluated.
//
// Live (iMac, icefox2000, 25 Nov 2026, post-deploy183 window): every idle window logged
//   [idle-practice] filtering out eatTwoSalmon: postcondition already met (has all of: granite)
// while the bot stood at 13-16 HP carrying salmon. granite is an incidental gain recorded inside the runs that
// verified the skill's effects (mining while walking to the fish); its learned post
// (salmon down >= 1, hp up) never holds without eating, so the effects proxy — a stand-in that exists for skills
// with no evaluable post — starved the bot's own food skill forever: granite never leaves the inventory.
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { recordEffectEvidence, recordConsumeEvidence } from '../src/agent/consume_evidence.js';
let Voyager;
before(async () => { const mod = await import('../src/agent/voyager.js'); Voyager = mod.Voyager; mod._setVersionForTest('1.21.4'); });

function mkV() {
    const v = Object.create(Voyager.prototype);
    Object.assign(v, { skills: [], progress: {}, _unverifiedConsumesNoted: new Set(), _unjudgeableNoted: new Set() });
    return v;
}

// the live eatTwoSalmon shape: a delta post (salmon down, hp up) and a verified-but-incidental effect (granite)
function mkSalmon() {
    const s = {
        name: 'eatTwoSalmon', effects: [], consumes: {},
        contract: {
            pre: "c => (c.pre.inv['salmon'] || 0) >= 2",
            post: "c => c.ret === false || ((c.pre.inv['salmon'] - (c.post.inv['salmon'] || 0)) >= 1 && c.post.hp > c.pre.hp)",
        },
        stats: { uncertainty: 0.2, success: 3, fail: 0, effectEvidence: {}, consumeEvidence: {} },
    };
    recordEffectEvidence(s, { granite: 0 }, { granite: 8 }, null);   // incidental gain during the recorded run
    return s;
}

describe('fix184: effects proxy yields to the contract post', () => {
    it('a verified incidental effect no longer filters a skill whose evaluable post does not hold', () => {
        const v = mkV(), s = mkSalmon();
        const obs = { inventory: { granite: 8, salmon: 3 }, health_value: 13 };
        // post is evaluable here (salmon present, hp present) and false: eating could still help
        assert.strictEqual(v._practicePostAlreadyMet(s, obs).evaluable, true);
        assert.strictEqual(v._practicePostAlreadyMet(s, obs).met, false);
        // pre-fix184 this returned "postcondition already met (has all of: granite)"
        assert.strictEqual(v._shouldSkipPractice(s, obs, new Set()), null);
    });
    it('the proxy still gates when the post cannot be evaluated on the current observation', () => {
        const v = mkV(), s = mkSalmon();
        // no salmon in the observation: the post reads inv.salmon and cannot be evaluated — the fix42 proxy remains
        const obs = { inventory: { granite: 8 }, health_value: 20 };
        assert.strictEqual(v._practicePostAlreadyMet(s, obs).evaluable, false);
        assert.match(v._shouldSkipPractice(s, obs, new Set()), /postcondition already met \(has all of: granite\)/);
    });
    it('scarce-pending consumes gating is untouched by the change', () => {
        const v = mkV(), s = mkSalmon();
        recordConsumeEvidence(s, { salmon: 4 }, { salmon: 3 });   // measured consume of salmon
        s.consumes = { salmon: 1 };
        const obs = { inventory: { granite: 8, salmon: 1 }, health_value: 13 };
        assert.match(v._shouldSkipPractice(s, obs, new Set(['salmon'])), /would consume scarce salmon/);
    });
});
