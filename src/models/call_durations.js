// fix60: learned bound on a local model call's wait. Ollama (stream:false) sends nothing until the reply is complete and the
// implicit undici 300 s header/body timers are disabled, so a server that hangs without closing the socket would otherwise
// stall the bot silently. The bound comes only from this model+endpoint's own successful calls: the largest success plus the
// observed range (max + (max - min)). No bound exists (call unbounded, logged loudly) until two different durations are seen.
// A call cut at the bound lasted at least that long, so the cut is recorded as an observation too: the next bound is larger,
// so a legitimately slower call is never starved forever while a true hang is still cut and reported every time.
// The store is a plain object persisted by the owner (voyager progress.callDurations); without one every call is unbounded.
let _store = null;
export function setCallDurationStore(store) {
    if (!store || typeof store !== 'object') throw new Error('[call-durations] store must be an object');
    _store = store;
}
export function callDurationStore() { return _store; }
export function recordCallDuration(key, ms) {
    if (!_store) return;   // no owner attached (tests, chat-only use): nothing to learn into
    const s = _store[key];
    if (!s) { _store[key] = { n: 1, min: ms, max: ms }; return; }
    s.n += 1; if (ms < s.min) s.min = ms; if (ms > s.max) s.max = ms;
}
export function callDurationBound(key) {
    const s = _store ? _store[key] : undefined;
    if (!s || s.max === s.min) return null;
    return { ms: s.max + (s.max - s.min), stats: s };
}

// fix61: a model+endpoint with no learned bound is announced ONCE, not on every call. The startup library re-embed fires its
// nomic-embed-text calls concurrently, all before any has finished, so per-call logging printed the same line ~94 times.
// The calls made while unbounded are counted, and the moment the bound is learned it is announced once with that count.
const _unbounded = {};
export function noteUnboundedCall(key) {
    const first = !(key in _unbounded);
    _unbounded[key] = (_unbounded[key] || 0) + 1;
    return first;
}
export function takeLearnedBound(key) {
    if (!(key in _unbounded)) return null;
    const bound = callDurationBound(key);
    if (!bound) return null;
    const calls = _unbounded[key]; delete _unbounded[key];
    return { calls, bound };
}
