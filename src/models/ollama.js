import { strictFormat } from '../utils/text.js';
import { Agent } from 'undici';
import { recordCall, recordCut, callBound, requestShape, workOf, noteUnboundedCall, takeLearnedBound } from './call_durations.js';
import { inferenceTiming, formatOllamaTiming } from './inference_timing.js';
import { parseContextOverflow, chatSectionSizes } from '../agent/prompt_cut.js';

// fix60: Ollama with stream:false sends its response headers only after the whole generation, so undici's implicit
// 300 s headersTimeout/bodyTimeout (the global Agent installed when cheerio loads undici) killed long but healthy local
// calls with UND_ERR_HEADERS_TIMEOUT. A dedicated dispatcher with those implicit timers disabled (0) lets the call end
// on Ollama's own reply or error, or on the connection failing.
const OLLAMA_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

// fix96: Ollama's /api/chat defaults truncate:true (drops chat messages when the rendered prompt exceeds num_ctx)
// and shift:true (drops context when generation reaches num_ctx). Both cut prompt text without saying so.
// Off, a prompt that does not fit is an HTTP 400 naming its real token count, and a reply that runs out of
// context ends with done_reason "length" (fix31 throws).
export const NEVER_CUT_PROMPT = Object.freeze({ truncate: false, shift: false });
// fix96: the error code of a call whose prompt (or prompt + reply) does not fit the model's context. It is a failure of that
//        one call, loud, and not a broken agent: restarting rebuilds the same prompt, so the step loop must not exit on it
//        (voyager _onStepError). The caller of a repair/refactor/contract call already fails only that call.
export const CONTEXT_FULL = 'CONTEXT_FULL';
function contextFull(message, counts) {
    if (!counts || !Number.isInteger(counts.requestTokens) || !Number.isInteger(counts.contextTokens))
        throw new Error(`[fix97] context overflow is missing token counts: ${message}`);
    const e = new Error(message);
    e.code = CONTEXT_FULL;
    e.requestTokens = counts.requestTokens;
    e.contextTokens = counts.contextTokens;
    if (Object.hasOwn(counts, 'replyTokens')) {
        if (!Number.isInteger(counts.replyTokens)) throw new Error(`[fix97] context overflow reply token count is not an integer: ${message}`);
        e.replyTokens = counts.replyTokens;
    }
    return e;
}

export class Ollama {
    static prefix = 'ollama';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url || 'http://127.0.0.1:11434';
        this.chat_endpoint = '/api/chat';
        this.embedding_endpoint = '/api/embeddings';
    }

    async sendRequest(turns, systemMessage, meta) {
        let model = this.model_name || 'sweaterdog/andy-4:micro-q8_0';
        let messages = strictFormat(turns);
        messages.unshift({ role: 'system', content: systemMessage });
        const maxAttempts = 5;
        let attempt = 0;
        let finalRes = null;

        while (attempt < maxAttempts) {
            attempt++;
            console.log(`Awaiting local response... (model: ${model}, attempt: ${attempt})`);
            let res = null, truncated = null;
            try {
                let apiResponse = await this.send(this.chat_endpoint, {
                    model: model,
                    messages: messages,
                    stream: false,
                    ...(this.params || {}),
                    ...NEVER_CUT_PROMPT,
                    keep_alive: this._keepAlive()
                }, meta);
                if (apiResponse?.done_reason === 'length') { truncated = apiResponse; }   // fix31
                if (apiResponse) {
                    res = apiResponse['message']['content'];
                } else {
                    res = 'No response data.';
                }
            } catch (err) {
                if (err.code === 'OLLAMA_LEARNED_BOUND') throw err;   // fix60: a hang beyond the learned bound fails loud, never a canned reply
                const message = err instanceof Error ? err.message : String(err);
                const overflow = parseContextOverflow(message);
                if (overflow) {
                    throw contextFull(`!!! [fix96] ${model}: prompt does not fit: ${overflow.requestTokens} tokens, context ${overflow.contextTokens} tokens; nothing was cut and nothing was sent to the model (message chars: ${chatSectionSizes(messages)}). ${message}`, { requestTokens: overflow.requestTokens, contextTokens: overflow.contextTokens });
                }
                throw err instanceof Error ? err : new Error(message);
            }

            if (truncated) {
                // fix96: with shift off, a reply that reaches the end of the context stops there (done_reason "length", as at a
                //        num_predict cap); which of the two it was is read from the counts Ollama returns
                const ctx = this.params && this.params.options ? this.params.options.num_ctx : undefined;
                if (Number.isInteger(ctx) && truncated.prompt_eval_count + truncated.eval_count >= ctx)
                    throw contextFull(`!!! [fix96] ${model}: prompt (${truncated.prompt_eval_count} tokens) + reply (${truncated.eval_count} tokens) reached the context (${ctx} tokens); the reply is incomplete and nothing was cut (message chars: ${chatSectionSizes(messages)})`, { requestTokens: truncated.prompt_eval_count, contextTokens: ctx, replyTokens: truncated.eval_count });
                throw new Error(`[ollama] ${model}: reply hit the num_predict cap (${truncated.eval_count} tokens) - incomplete: ${String(res).slice(0, 160)}`);   // fix31: fail loudly
            }
            const hasOpenTag = res.includes("<think>");
            const hasCloseTag = res.includes("</think>");

            if ((hasOpenTag && !hasCloseTag)) {
                console.warn("Partial <think> block detected. Re-generating...");
                if (attempt < maxAttempts) continue;
            }
            if (hasCloseTag && !hasOpenTag) {
                res = '<think>' + res;
            }
            if (hasOpenTag && hasCloseTag) {
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
            finalRes = res;
            break;
        }

        if (finalRes == null) {
            console.warn("Could not get a valid response after max attempts.");
            finalRes = 'I thought too hard, sorry, try again.';
        }
        return finalRes;
    }

    // fix17: chat requests always carry the profile's keep_alive (mo_bot: -1 = keep loaded); missing -> fail loudly
    _keepAlive() {
        const k = this.params?.keep_alive;
        if (k === undefined) throw new Error(`[ollama] ${this.model_name}: profile params.keep_alive is not set`);
        if (!this._kaLogged) { this._kaLogged = true; console.log(`[ollama] chat keep_alive=${k} for ${this.model_name}`); }
        return k;
    }

    async embed(text) {
        // fix14: /api/embed, model pinned in memory (keep_alive -1); no fallback, fail loudly
        if (!this.model_name) throw new Error('[embed] no embedding model configured');
        const res = await this.send('/api/embed', { model: this.model_name, input: text, keep_alive: -1, truncate: false });   // fix96: Ollama's default truncate:true cut long inputs silently
        const v = res?.embeddings?.[0];
        if (!Array.isArray(v) || !v.length) throw new Error(`[embed] ${this.model_name} returned no embedding`);
        return v;
    }

    async send(endpoint, body, meta) {
        const url = new URL(endpoint, this.url);
        let method = 'POST';
        let headers = new Headers();
        const request = new Request(url, { method, headers, body: JSON.stringify(body) });
        // fix60/fix63: the wait is bounded by this model+endpoint's learned per-token rates scaled to this request (see call_durations.js)
        const key = `${this.model_name} ${endpoint}`;
        const shape = requestShape(endpoint, body);
        const bound = callBound(key, shape);
        if (bound.ms === null && noteUnboundedCall(key)) console.log(`!!! [ollama] UNBOUNDED calls ${key}: ${bound.why}; a hang here would not be cut (logged once per model+endpoint until a bound is learned)`);
        const t0 = Date.now();
        let res;
        try { res = await fetch(request, bound.ms !== null ? { dispatcher: OLLAMA_DISPATCHER, signal: AbortSignal.timeout(bound.ms) } : { dispatcher: OLLAMA_DISPATCHER }); }
        catch (err) {
            if (bound.ms !== null && err?.name === 'TimeoutError') {
                const s = bound.stats;
                const e = new Error(`[ollama] ${key} exceeded its learned bound ${bound.ms}ms for this request (~${bound.pTok} prompt tokens, up to ${bound.gen} generated; learned over ${Math.round(s.over)}ms, prompt ${s.pRate.toFixed(2)}ms/tok, gen ${s.gRate === undefined ? '-' : s.gRate.toFixed(2)}ms/tok, n=${s.n}); aborted as a hang`);
                recordCut(key, Date.now() - t0, bound);   // censored: it took at least this long; widens the next bound
                e.code = 'OLLAMA_LEARNED_BOUND'; console.error('!!! ' + e.message); throw e;
            }
            throw err;
        }
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            const errMsg = `Ollama ${res.status}: ${errText || res.statusText}`;
            console.error(`[ollama] ${this.model_name} request FAILED: ${errMsg}`);
            throw new Error(errMsg);
        }
        const json = await res.json();
        const wallMs = Date.now() - t0;
        console.log(formatOllamaTiming(this.model_name, inferenceTiming({ json, wallMs, url: this.url, meta })));
        recordCall(key, wallMs, shape.chars, workOf(endpoint, json));
        const learned = takeLearnedBound(key, shape);
        if (learned) console.log(`[ollama] ${key} now bounded (${learned.bound.ms}ms for a request like this one; learned from n=${learned.bound.stats.n} calls; ${learned.calls} call(s) ran unbounded)`);
        return json;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage);
    }
}
