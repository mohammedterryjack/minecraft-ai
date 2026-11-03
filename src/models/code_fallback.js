// Gemini-only wrapper: on quota / rate-limit errors, pause for cooldownMs and fail loudly.
// (A fallback model is only used if one is explicitly passed; mo_bot passes none.)
export function isQuotaError(err) {
    const s = String(err?.status ?? err?.code ?? '') + ' ' + String(err?.message ?? err);
    return /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit|usage limit/i.test(s);
}
export class CodeModelWithFallback {
    constructor(primary, fallback, cooldownMs = 60 * 60 * 1000, label = 'code-model') {
        this.label = label;
        this.primary = primary; this.fallback = fallback; this.cooldownMs = cooldownMs;
        this.quotaUntil = 0; this.fallbackQuotaUntil = 0; this.fallbackCooldownMs = 60 * 60 * 1000; this.onFallback = false; this.switchOn = null; this.timeoutMs = 120 * 1000;
        this.pName = primary.model_name || 'primary'; this.fName = fallback ? (fallback.model_name || 'fallback') : null;
    }
    async sendRequest(turns, systemMessage) {
        if (Date.now() < this.quotaUntil) {
            if (!this.fallback && this.label === 'chat-model') { console.error(`[chat-model] paused: gemini quota cooldown (no local fallback)`); return 'Gemini quota is used up, so I am paused for a while.'; }
            if (!this.fallback) throw new Error(`[${this.label}] ${this.pName} quota cooldown active until ${new Date(this.quotaUntil).toISOString()} - paused (no local fallback)`);
            return await this._useFallback(turns, systemMessage);
        }
        try {
            const r = await Promise.race([
                this.primary.sendRequest(turns, systemMessage),
                new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${this.timeoutMs/1000}s`)), this.timeoutMs)),
            ]);
            console.log(`[${this.label}] used ${this.pName}`);
            if (this.onFallback) { this.onFallback = false; console.warn(`[${this.label}] SWITCH back to ${this.pName}: limit recovered`); }
            return r;
        } catch (err) {
            if (isQuotaError(err) && (!this.fallback || !this.switchOn || this.switchOn.test(String(err?.message ?? err)) || err?.status === 429)) {
                this.quotaUntil = Date.now() + this.cooldownMs;
                if (!this.fallback) {
                    console.error(`[${this.label}] ${this.pName} quota/usage limit hit - PAUSED for ${Math.round(this.cooldownMs/60000)} min (no local fallback)`);
                    if (this.label === 'chat-model') return 'Gemini quota is used up, so I am paused for a while.';
                    throw err;
                }
                console.warn(`[${this.label}] SWITCH ${this.pName} -> ${this.fName}: ${this.pName} usage limit hit (retrying ${this.pName} after ${Math.round(this.cooldownMs/60000)} min)`);
                return await this._useFallback(turns, systemMessage);
            }
            console.error(`[${this.label}] ${this.pName} FAILED (not quota, no switch): ${err?.message ?? err}`);
            throw err;
        }
    }
    async _useFallback(turns, systemMessage) {
        if (Date.now() < this.fallbackQuotaUntil)
            throw new Error(`[${this.label}] ${this.pName} and ${this.fName} both quota-limited - paused until ${new Date(Math.min(this.quotaUntil, this.fallbackQuotaUntil)).toISOString()}`);
        if (!this.onFallback) { this.onFallback = true; }
        try {
            const r = await this.fallback.sendRequest(turns, systemMessage);
            console.log(`[${this.label}] used ${this.fName} (backup)`);
            return r;
        } catch (err) {
            if (isQuotaError(err)) {
                this.fallbackQuotaUntil = Date.now() + this.fallbackCooldownMs;
                console.error(`[${this.label}] ${this.fName} backup quota/usage limit hit too - PAUSED for ${Math.round(this.fallbackCooldownMs/60000)} min: ${String(err?.message ?? err).slice(0,120)}`);
                throw err;
            }
            console.error(`[${this.label}] ${this.fName} backup FAILED (not quota): ${err?.message ?? err}`);
            throw err;
        }
    }
}
