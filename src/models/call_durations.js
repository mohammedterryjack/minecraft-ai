// fix60: learned bound on a local model call's wait. Ollama (stream:false) sends nothing until the reply is complete and the
// implicit undici 300 s header/body timers are disabled, so a server that hangs without closing the socket would otherwise
// stall the bot silently.
// fix63: the bound is learned as RATES, scaled by THIS call's work, not as a spread of past wall times. A call's time is set by
// how many prompt tokens it evaluates and how many it may generate; the fix60 bound (max + (max - min) of past durations)
// ignored both, so a learned sample of mid-sized prompts with short replies cut a healthy call that had the session's largest
// prompt (12:41:14Z: 24488 chars, bound 71577 ms from n=45 calls of at most 38840 ms; healthy calls of 50-56 s and, before
// fix60, 95-149 s with ~1800 generated tokens). Learned per model+endpoint from Ollama's own reply counters:
//   cpt   - fewest prompt chars per prompt token seen (so chars / cpt never under-counts tokens)
//   pRate - slowest prompt-eval ms per token; gRate - slowest generation ms per token
//   over  - largest wall time not spent evaluating or generating (load, queue, network)
// bound = over + max(pRate, gRate) * promptTokens + gRate * genBudget, where genBudget is what the request lets the model
// generate (options.num_predict, else options.num_ctx minus the prompt). Prompt tokens are charged at the larger learned rate
// because early samples can all be KV-cache-warm prefills (live 0.04-5.3 ms/token vs decode ~50 ms/token).
// A cut call lasted at least its bound; the excess is folded into `over`, so the next bound for the same work is larger.
// The store is a plain object persisted by the owner (voyager progress.callDurations); without one every call is unbounded.
let _store = null;
export function setCallDurationStore(store) {
    if (!store || typeof store !== 'object') throw new Error('[call-durations] store must be an object');
    _store = store;
}
export function callDurationStore() { return _store; }

const ms = ns => ns / 1e6;
// Ollama reply counters -> evaluated work. Each endpoint reports its own fields; a missing one fails loud.
export function workOf(endpoint, res) {
    const need = (...ks) => { for (const k of ks) if (typeof res[k] !== 'number') throw new Error(`[call-durations] ${endpoint} reply has no numeric ${k}`); };
    if (endpoint === '/api/embed') { need('prompt_eval_count', 'total_duration', 'load_duration'); return { pTok: res.prompt_eval_count, pMs: ms(res.total_duration - res.load_duration), gTok: 0, gMs: 0 }; }
    if (endpoint === '/api/chat') { need('prompt_eval_count', 'prompt_eval_duration', 'eval_count', 'eval_duration'); return { pTok: res.prompt_eval_count, pMs: ms(res.prompt_eval_duration), gTok: res.eval_count, gMs: ms(res.eval_duration) }; }
    throw new Error(`[call-durations] no work model for endpoint ${endpoint}`);
}
// What a request lets the model do: its prompt size in chars and how many tokens it may generate (null: not derivable).
export function requestShape(endpoint, body) {
    if (endpoint === '/api/embed') return { chars: [].concat(body.input).join('').length, genBudget: () => 0 };
    if (endpoint === '/api/chat') {
        const o = body.options;
        const chars = body.messages.map(m => String(m.content)).join('').length;
        if (o && typeof o.num_predict === 'number' && o.num_predict >= 0) return { chars, genBudget: () => o.num_predict };
        if (o && typeof o.num_ctx === 'number') return { chars, genBudget: pTok => Math.max(0, o.num_ctx - pTok) };
        return { chars, genBudget: null };
    }
    throw new Error(`[call-durations] no request shape for endpoint ${endpoint}`);
}
export function recordCall(key, wallMs, chars, work) {
    if (!_store) return;   // no owner attached (tests, chat-only use): nothing to learn into
    if (!_store[key]) _store[key] = { n: 0, min: wallMs, max: wallMs };
    const s = _store[key];
    s.n += 1; if (wallMs < s.min) s.min = wallMs; if (wallMs > s.max) s.max = wallMs;
    if (work.pTok > 0) {
        const cpt = chars / work.pTok, pRate = work.pMs / work.pTok;
        if (s.cpt === undefined || cpt < s.cpt) s.cpt = cpt;
        if (s.pRate === undefined || pRate > s.pRate) s.pRate = pRate;
    }
    if (work.gTok > 0) { const gRate = work.gMs / work.gTok; if (s.gRate === undefined || gRate > s.gRate) s.gRate = gRate; }
    const over = Math.max(0, wallMs - work.pMs - work.gMs);
    if (s.over === undefined || over > s.over) s.over = over;
}
// null with a reason when this key has not learned what the bound needs yet
export function callBound(key, shape) {
    const s = _store ? _store[key] : undefined;
    if (!s || s.cpt === undefined || s.pRate === undefined || s.over === undefined) return { ms: null, why: 'no successful call with reply counters learned yet' };
    if (!shape.genBudget) return { ms: null, why: 'request sets neither options.num_predict nor options.num_ctx, so its generation is unbounded' };
    const pTok = Math.ceil(shape.chars / s.cpt), gen = shape.genBudget(pTok);
    if (gen > 0 && s.gRate === undefined) return { ms: null, why: 'no generation rate learned yet' };
    const promptRate = s.gRate === undefined ? s.pRate : Math.max(s.pRate, s.gRate);   // embed endpoints never generate
    const ms = Math.ceil(s.over + promptRate * pTok + (gen > 0 ? s.gRate * gen : 0));
    return { ms, pTok, gen, stats: s };
}
// a call cut at its bound lasted at least that long: fold the excess over its estimated work into `over`
export function recordCut(key, wallMs, bound) {
    const s = _store[key];
    const work = bound.ms - s.over;
    const over = wallMs - work;
    if (over > s.over) s.over = over;
}

// fix61: a model+endpoint with no learned bound is announced ONCE, not on every call (concurrent startup re-embeds printed
// the same line ~94 times). The calls made while unbounded are counted and announced once when the bound is learned.
const _unbounded = {};
export function noteUnboundedCall(key) {
    const first = !(key in _unbounded);
    _unbounded[key] = (_unbounded[key] || 0) + 1;
    return first;
}
export function takeLearnedBound(key, shape) {
    if (!(key in _unbounded)) return null;
    const bound = callBound(key, shape);
    if (bound.ms === null) return null;
    const calls = _unbounded[key]; delete _unbounded[key];
    return { calls, bound };
}
