// fix93: per-call Ollama timing. A missing duration is `unavailable`. It is never coerced to 0,
// and it is never read as evidence of RAM pressure on the machine that sent the request.

function phase(json, key) {
    if (json === null || typeof json !== 'object') throw new Error('[fix93] ollama response must be an object');
    if (!Object.hasOwn(json, key)) return { status: 'unavailable' };
    const v = json[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`[fix93] ollama ${key} is present but not a finite number`);
    return { status: 'measured', ns: v, ms: v / 1e6 };
}

function countField(json, key) {
    if (!Object.hasOwn(json, key)) return { status: 'unavailable' };
    const v = json[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`[fix93] ollama ${key} is present but not a finite number`);
    return { status: 'measured', n: v };
}

export function hostAttribution(url) {
    if (typeof url !== 'string' || url.length === 0) throw new Error('[fix93] model url required');
    let host;
    try { host = new URL(url).hostname; }
    catch (err) { throw new Error(`[fix93] model url is not a URL (${url}): ${err.message}`); }
    const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    return { host, attribution: local ? 'local-process' : 'remote-model-host' };
}

export function componentSizes(components) {
    if (components === null || components === undefined) return { status: 'unavailable' };
    if (typeof components !== 'object') throw new Error('[fix93] prompt components must be an object of sizes');
    const parts = {};
    for (const [k, v] of Object.entries(components)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`[fix93] prompt component ${k} size is not a finite number`);
        parts[k] = v;
    }
    return { status: 'measured', parts };
}

export function inferenceTiming({ json, wallMs, url, meta }) {
    if (typeof wallMs !== 'number' || !Number.isFinite(wallMs)) throw new Error('[fix93] wallMs required');
    const load = phase(json, 'load_duration');
    const prompt = phase(json, 'prompt_eval_duration');
    const gen = phase(json, 'eval_duration');
    const total = phase(json, 'total_duration');
    let queue = { status: 'unavailable' };
    if (load.status === 'measured' && prompt.status === 'measured' && gen.status === 'measured' && total.status === 'measured') {
        queue = { status: 'measured', ms: total.ms - (load.ms + prompt.ms + gen.ms) };
    }
    let transport = { status: 'unavailable' };
    if (total.status === 'measured') transport = { status: 'measured', ms: wallMs - total.ms };
    const host = hostAttribution(url);
    const components = componentSizes(meta && meta.components);
    const kind = meta && typeof meta.kind === 'string' && meta.kind.length > 0 ? meta.kind : null;
    const requestId = meta && typeof meta.requestId === 'string' && meta.requestId.length > 0 ? meta.requestId : null;
    return {
        load, prompt, gen, total, queue, transport, host, components, wallMs,
        promptTokens: countField(json, 'prompt_eval_count'),
        genTokens: countField(json, 'eval_count'),
        kind: kind === null ? { status: 'unavailable' } : { status: 'measured', kind },
        requestId: requestId === null ? { status: 'unavailable' } : { status: 'measured', requestId },
    };
}

function msText(p) {
    return p.status === 'measured' ? String(Math.round(p.ms)) : 'unavailable';
}
function nText(p) {
    return p.status === 'measured' ? String(p.n) : 'unavailable';
}

export function formatOllamaTiming(model, timing) {
    if (typeof model !== 'string' || model.length === 0) throw new Error('[fix93] model name required');
    const kind = timing.kind.status === 'measured' ? timing.kind.kind : 'unavailable';
    const request = timing.requestId.status === 'measured' ? timing.requestId.requestId : 'unavailable';
    let components = 'unavailable';
    if (timing.components.status === 'measured') {
        components = Object.entries(timing.components.parts).map(([k, v]) => `${k}=${v}`).join(',');
        if (components.length === 0) components = 'none';
    }
    return `[ollama-timing] model=${model} host=${timing.host.host} attribution=${timing.host.attribution} request=${request} kind=${kind} prompt_tokens=${nText(timing.promptTokens)} prompt_ms=${msText(timing.prompt)} gen_tokens=${nText(timing.genTokens)} gen_ms=${msText(timing.gen)} load_ms=${msText(timing.load)} queue_ms=${msText(timing.queue)} transport_ms=${msText(timing.transport)} total_ms=${msText(timing.total)} wall_ms=${Math.round(timing.wallMs)} components=${components}`;
}
