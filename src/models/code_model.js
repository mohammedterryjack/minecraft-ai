// fix32: single-path model wrapper (was CodeModelWithFallback). On a quota / rate-limit error it pauses for
// cooldownMs and THROWS (chat and code model alike); while paused every call throws. No fallback model.
export function isQuotaError(err) {
    const s = String(err?.status ?? err?.code ?? '') + ' ' + String(err?.message ?? err);
    return /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit|usage limit/i.test(s);
}
export class CodeModel {
    constructor(primary, cooldownMs = 60 * 60 * 1000, label = 'code-model') {
        this.label = label; this.primary = primary; this.cooldownMs = cooldownMs;
        this.quotaUntil = 0; this.timeoutMs = 120 * 1000; this.pName = primary.model_name || 'primary';
    }
    async sendRequest(turns, systemMessage) {
        if (Date.now() < this.quotaUntil) throw new Error(`[${this.label}] ${this.pName} quota cooldown active until ${new Date(this.quotaUntil).toISOString()} - paused`);
        let timer;
        try {
            const r = await Promise.race([
                this.primary.sendRequest(turns, systemMessage),
                new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${this.timeoutMs / 1000}s`)), this.timeoutMs); }),
            ]);
            console.log(`[${this.label}] used ${this.pName}`);
            return r;
        } catch (err) {
            if (isQuotaError(err)) { this.quotaUntil = Date.now() + this.cooldownMs; console.error(`[${this.label}] ${this.pName} quota/usage limit hit - PAUSED for ${Math.round(this.cooldownMs / 60000)} min`); }
            else console.error(`[${this.label}] ${this.pName} FAILED: ${err?.message ?? err}`);
            throw err;
        } finally { clearTimeout(timer); }
    }
}
