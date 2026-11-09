import { strictFormat } from '../utils/text.js';
import { Agent } from 'undici';
import { recordCall, recordCut, callBound, requestShape, workOf, noteUnboundedCall, takeLearnedBound, learnedCharsPerToken, notePromptDensity, callDurationStore } from './call_durations.js';
import { inferenceTiming, formatOllamaTiming } from './inference_timing.js';
import { resolveContextLength, promptBudget, estimateTokens, fitChatToBudget, parseContextOverflow } from '../agent/prompt_cut.js';

// fix60: Ollama with stream:false sends its response headers only after the whole generation, so undici's implicit
// 300 s headersTimeout/bodyTimeout (the global Agent installed when cheerio loads undici) killed long but healthy local
// calls with UND_ERR_HEADERS_TIMEOUT. A dedicated dispatcher with those implicit timers disabled (0) lets the call end
// on Ollama's own reply or error, or on the connection failing.
const OLLAMA_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

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
        const budget = await this._promptBudget();
        messages = this._fitToBudget(messages, budget);
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
                    this._noteOverflow(messages, overflow);
                    throw new Error(`[fix94] Ollama context overflow: request is ${overflow.requestTokens} tokens and the model context is ${overflow.contextTokens} tokens (prompt budget ${budget}). ${message}`);
                }
                throw err instanceof Error ? err : new Error(message);
            }

            if (truncated) throw new Error(`[ollama] ${model}: reply hit the num_predict cap (${truncated.eval_count} tokens) - incomplete: ${String(res).slice(0, 160)}`);   // fix31: fail loudly
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

    // Context the request will run in: options.num_ctx when the profile sets it, otherwise
    // /api/show model_info <architecture>.context_length. num_predict, when set, stays free for generation.
    async _promptBudget() {
        const options = this.params && this.params.options;
        const numPredict = options && Object.hasOwn(options, 'num_predict') ? options.num_predict : undefined;
        if (options && Object.hasOwn(options, 'num_ctx')) return promptBudget(resolveContextLength(this.params, null).length, numPredict);
        const show = await this._showModel();
        return promptBudget(resolveContextLength(this.params, show).length, numPredict);
    }

    async _showModel() {
        if (this._modelShown) return this._modelShown;
        if (typeof this.model_name !== 'string' || this.model_name.length === 0) throw new Error('[fix94] ollama model name required for /api/show');
        const url = new URL('/api/show', this.url);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: this.model_name }),
            dispatcher: OLLAMA_DISPATCHER,
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`[fix94] /api/show failed for ${this.model_name}: ${res.status} ${text}`);
        }
        const body = await res.json();
        this._modelShown = body;
        return body;
    }

    _fitToBudget(messages, budget) {
        if (!messages.every((message) => typeof message.content === 'string')) return messages;
        const cpt = typeof this.model_name === 'string' ? learnedCharsPerToken(`${this.model_name} /api/chat`) : undefined;
        const before = estimateTokens(messages.map((message) => message.content).join(''), cpt);
        const fitted = fitChatToBudget(messages, budget, (text) => estimateTokens(text, cpt));
        if (fitted.cut) console.log(`[fix94] ${this.model_name}: prompt cut from ${before} tokens to ${fitted.tokens} to fit context budget ${budget}`);
        return fitted.messages;
    }

    _noteOverflow(messages, overflow) {
        if (!callDurationStore()) return;
        if (typeof this.model_name !== 'string' || this.model_name.length === 0) return;
        if (overflow.requestTokens <= 0) return;
        const chars = messages.reduce((sum, message) => sum + (typeof message.content === 'string' ? message.content.length : 0), 0);
        if (chars <= 0) return;
        notePromptDensity(`${this.model_name} /api/chat`, chars, overflow.requestTokens);
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
        const res = await this.send('/api/embed', { model: this.model_name, input: text, keep_alive: -1 });
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
