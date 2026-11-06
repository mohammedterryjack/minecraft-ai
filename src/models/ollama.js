import { strictFormat } from '../utils/text.js';
import { Agent } from 'undici';
import { recordCallDuration, callDurationBound } from './call_durations.js';

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

    async sendRequest(turns, systemMessage) {
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
                    keep_alive: this._keepAlive()
                });
                if (apiResponse?.done_reason === 'length') { truncated = apiResponse; }   // fix31
                if (apiResponse) {
                    res = apiResponse['message']['content'];
                    console.log(`[ollama-timing] model=${this.model_name} prompt_tokens=${apiResponse.prompt_eval_count} prompt_ms=${Math.round((apiResponse.prompt_eval_duration||0)/1e6)} gen_tokens=${apiResponse.eval_count} total_ms=${Math.round((apiResponse.total_duration||0)/1e6)}`);
                } else {
                    res = 'No response data.';
                }
            } catch (err) {
                if (err.code === 'OLLAMA_LEARNED_BOUND') throw err;   // fix60: a hang beyond the learned bound fails loud, never a canned reply
                if (err.message.toLowerCase().includes('context length') && turns.length > 1) {
                    console.log('Context length exceeded, trying again with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage);
                } else {
                    console.log(err);
                    res = 'My brain disconnected, try again.';
                }
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

    async send(endpoint, body) {
        const url = new URL(endpoint, this.url);
        let method = 'POST';
        let headers = new Headers();
        const request = new Request(url, { method, headers, body: JSON.stringify(body) });
        // fix60: the wait is bounded only by this model+endpoint's learned successful-call durations (see call_durations.js)
        const key = `${this.model_name} ${endpoint}`;
        const bound = callDurationBound(key);
        if (!bound) console.log(`!!! [ollama] UNBOUNDED call ${key}: no learned duration distribution yet (needs two different successful durations); a hang here would not be cut`);
        const t0 = Date.now();
        let res;
        try { res = await fetch(request, bound ? { dispatcher: OLLAMA_DISPATCHER, signal: AbortSignal.timeout(bound.ms) } : { dispatcher: OLLAMA_DISPATCHER }); }
        catch (err) {
            if (bound && err?.name === 'TimeoutError') {
                const e = new Error(`[ollama] ${key} exceeded its learned bound ${bound.ms}ms (successful calls: n=${bound.stats.n}, min ${bound.stats.min}ms, max ${bound.stats.max}ms); aborted as a hang`);
                recordCallDuration(key, Date.now() - t0);   // censored: it took at least this long; widens the next bound
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
        recordCallDuration(key, Date.now() - t0);
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
