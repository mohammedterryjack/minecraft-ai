/**
 * fix63: the learned Ollama bound scales with the request's work (prompt tokens + allowed generation) instead of being a
 * spread of past wall times. Live: 12:41:14Z qwen2.5-coder:7b /api/chat cut at 71577 ms (old bound max 38840 + range, n=45)
 * on the session's largest prompt (24488 chars) while healthy calls ran 50-56 s (and 95-149 s before fix60).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as cd from '../src/models/call_durations.js';

// live 12:15-12:42Z samples (chars, prompt tokens, prompt ms, gen tokens, wall ms) from [ollama-timing] + composer lines
const LIVE = [[17308, 4921, 492, 150, 8549], [16621, 4738, 22270, 150, 30009], [18205, 5255, 25226, 150, 33058], [21596, 6223, 32989, 163, 41243], [19525, 5594, 1454, 220, 12526]];
const learnLive = key => { for (const [c, p, pm, g, w] of LIVE) cd.recordCall(key, w, c, { pTok: p, pMs: pm, gTok: g, gMs: (w - pm) * 0.98 }); };

describe('fix63: request-scaled learned bound', () => {
    it('the 12:41 call (24488 chars, num_ctx 8192) is not cut where a healthy one would still be running', () => {
        cd.setCallDurationStore({});
        learnLive('q /api/chat');
        const shape = cd.requestShape('/api/chat', { messages: [{ role: 'system', content: 'x'.repeat(24488) }], options: { num_ctx: 8192 } });
        const b = cd.callBound('q /api/chat', shape);
        // a healthy completion of this request: ~7000 prompt tokens cold (5.3 ms/tok live max) + generation to the context end
        const s = b.stats, healthy = s.pRate * b.pTok + s.gRate * b.gen;
        assert.ok(b.ms >= healthy, `bound ${b.ms} >= healthy worst case ${Math.round(healthy)}`);
        assert.ok(b.ms > 71577, 'larger than the old wall-time bound that cut the live call');
    });
    it('the bound grows with the request: a larger prompt or a larger num_predict gets a larger bound', () => {
        cd.setCallDurationStore({});
        learnLive('q /api/chat');
        const at = (chars, opts) => cd.callBound('q /api/chat', cd.requestShape('/api/chat', { messages: [{ role: 'user', content: 'x'.repeat(chars) }], options: opts })).ms;
        assert.ok(at(20000, { num_predict: 200 }) > at(10000, { num_predict: 200 }));
        assert.ok(at(10000, { num_predict: 400 }) > at(10000, { num_predict: 200 }));
    });
    it('prompt tokens are charged at the larger learned per-token rate (warm-cache samples cannot under-learn a cold prefill)', () => {
        cd.setCallDurationStore({});
        cd.recordCall('w /api/chat', 1100, 4000, { pTok: 1000, pMs: 100, gTok: 20, gMs: 1000 });   // warm prefill 0.1 ms/tok, decode 50 ms/tok
        const b = cd.callBound('w /api/chat', { chars: 4000, genBudget: () => 0 });
        assert.strictEqual(b.ms, Math.ceil(0 + 50 * 1000), 'prefill bounded by the decode rate, not the warm 0.1 ms/tok');
    });
    it('no generation limit in the request -> unbounded with the reason, never a guessed bound', () => {
        cd.setCallDurationStore({});
        learnLive('q /api/chat');
        const b = cd.callBound('q /api/chat', cd.requestShape('/api/chat', { messages: [{ role: 'user', content: 'hi' }] }));
        assert.strictEqual(b.ms, null);
        assert.match(b.why, /neither options.num_predict nor options.num_ctx/);
    });
    it('a cut widens the next bound for the same work to at least the cut wall time', () => {
        cd.setCallDurationStore({});
        learnLive('q /api/chat');
        const shape = { chars: 20000, genBudget: () => 100 };
        const b = cd.callBound('q /api/chat', shape);
        cd.recordCut('q /api/chat', b.ms + 5000, b);
        assert.ok(cd.callBound('q /api/chat', shape).ms >= b.ms + 5000);
    });
    it('reply counters are required (fail loud), per endpoint', () => {
        assert.throws(() => cd.workOf('/api/chat', { prompt_eval_count: 1 }), /no numeric prompt_eval_duration/);
        assert.deepStrictEqual(cd.workOf('/api/embed', { prompt_eval_count: 3, total_duration: 5e6, load_duration: 1e6 }), { pTok: 3, pMs: 4, gTok: 0, gMs: 0 });
    });
});
