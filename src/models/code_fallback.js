// Primary code model with ONE switch-over: on quota / rate-limit errors only, use the fallback.
export function isQuotaError(err) {
    const s = String(err?.status ?? err?.code ?? '') + ' ' + String(err?.message ?? err);
    return /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(s);
}
export class CodeModelWithFallback {
    constructor(primary, fallback, cooldownMs = 60 * 60 * 1000, label = 'code-model') {
        this.label = label;
        this.primary = primary; this.fallback = fallback; this.cooldownMs = cooldownMs;
        this.quotaUntil = 0; this.timeoutMs = 120 * 1000;
        this.pName = primary.model_name || 'primary'; this.fName = fallback.model_name || 'fallback';
    }
    async sendRequest(turns, systemMessage) {
        if (Date.now() < this.quotaUntil) {
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
                console.warn(`[${this.label}] gemini quota exhausted -> ${this.fName} (retry ${this.pName} after ${Math.round(this.cooldownMs/60000)} min)`);
                return await this.fallback.sendRequest(turns, systemMessage);
            }
            console.error(`[${this.label}] ${this.pName} FAILED (not quota, no switch): ${err?.message ?? err}`);
            throw err;
        }
    }
}
