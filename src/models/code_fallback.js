// Gemini-only wrapper: on quota / rate-limit errors, pause for cooldownMs and fail loudly.
// (A fallback model is only used if one is explicitly passed; mo_bot passes none.)
export function isQuotaError(err) {
    const s = String(err?.status ?? err?.code ?? '') + ' ' + String(err?.message ?? err);
    return /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(s);
}
export class CodeModelWithFallback {
    constructor(primary, fallback, cooldownMs = 60 * 60 * 1000, label = 'code-model') {
        this.label = label;
        this.primary = primary; this.fallback = fallback; this.cooldownMs = cooldownMs;
        this.quotaUntil = 0; this.timeoutMs = 120 * 1000;
        this.pName = primary.model_name || 'primary'; this.fName = fallback ? (fallback.model_name || 'fallback') : null;
    }
    async sendRequest(turns, systemMessage) {
        if (Date.now() < this.quotaUntil) {
            if (!this.fallback && this.label === 'chat-model') { console.error(`[chat-model] paused: gemini quota cooldown (no local fallback)`); return 'Gemini quota is used up, so I am paused for a while.'; }
            if (!this.fallback) throw new Error(`[${this.label}] ${this.pName} quota cooldown active until ${new Date(this.quotaUntil).toISOString()} - paused (no local fallback)`);
            console.warn(`[${this.label}] ${this.pName} quota cooldown active -> ${this.fName}`);
            return await this.fallback.sendRequest(turns, systemMessage);
        }
        try {
            const r = await Promise.race([
                this.primary.sendRequest(turns, systemMessage),
                new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${this.timeoutMs/1000}s`)), this.timeoutMs)),
            ]);
            console.log(`[${this.label}] used ${this.pName}`);
            return r;
        } catch (err) {
            if (isQuotaError(err)) {
                this.quotaUntil = Date.now() + this.cooldownMs;
                if (!this.fallback) {
                    console.error(`[${this.label}] gemini quota exhausted - PAUSED for ${Math.round(this.cooldownMs/60000)} min (no local fallback)`);
                    if (this.label === 'chat-model') return 'Gemini quota is used up, so I am paused for a while.';
                    throw err;
                }
                console.warn(`[${this.label}] gemini quota exhausted -> ${this.fName} (retry ${this.pName} after ${Math.round(this.cooldownMs/60000)} min)`);
                return await this.fallback.sendRequest(turns, systemMessage);
            }
            console.error(`[${this.label}] ${this.pName} FAILED (not quota, no switch): ${err?.message ?? err}`);
            throw err;
        }
    }
}
