// fix32: single-path model wrapper. On a quota / rate-limit error:
//   - If a fallback is configured, EXPLICITLY switch to it with loud logging (the ONE allowed exception per Mo's principles)
//   - Otherwise pause for cooldownMs and THROW (fail loudly, no silent soft fallback)
export function isQuotaError(err) {
    const s = String(err?.status ?? err?.code ?? '') + ' ' + String(err?.message ?? err);
    return /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit|usage limit/i.test(s);
}
export class CodeModel {
    constructor(primary, cooldownMs = 60 * 60 * 1000, label = 'code-model', fallback = null) {
        this.label = label; this.primary = primary; this.cooldownMs = cooldownMs; this.fallback = fallback;
        this.quotaUntil = 0; this.pName = primary.model_name || 'primary';
        this.fName = fallback?.model_name || 'local-free'; this.onFallback = false; this.switchedAt = null;
    }
    async sendRequest(turns, systemMessage) {
        if (Date.now() < this.quotaUntil) {
            if (this.fallback) return await this._useFreeFallback(turns, systemMessage);
            throw new Error(`[${this.label}] ${this.pName} quota cooldown active until ${new Date(this.quotaUntil).toISOString()} - paused (no free fallback configured)`);
        }
        if (this.onFallback) {
            console.log(`[${this.label}] *** PAID PATH RECOVERED *** switching back to ${this.pName} (was on free fallback ${this.fName} since ${this.switchedAt})`);
            this.onFallback = false; this.switchedAt = null;
        }
        // fix51: no wrapper timeout (was a magic 120s/180s race); the provider owns its timeout and reports its own error
        try {
            const r = await this.primary.sendRequest(turns, systemMessage);
            console.log(`[${this.label}] used ${this.pName}`);
            return r;
        } catch (err) {
            if (isQuotaError(err)) {
                this.quotaUntil = Date.now() + this.cooldownMs;
                if (this.fallback) {
                    console.error(`\n!!! [${this.label}] *** PAID PATH EXHAUSTED *** ${this.pName} quota/usage limit hit !!!`);
                    console.error(`!!! [${this.label}] EXPLICIT SWITCH to FREE LOCAL CODER: ${this.fName} (retrying ${this.pName} after ${Math.round(this.cooldownMs / 60000)} min) !!!\n`);
                    return await this._useFreeFallback(turns, systemMessage);
                }
                console.error(`[${this.label}] ${this.pName} quota/usage limit hit - PAUSED for ${Math.round(this.cooldownMs / 60000)} min (no free fallback configured)`);
            } else console.error(`[${this.label}] ${this.pName} FAILED: ${err?.message ?? err}`);
            throw err;
        }
    }
    async _useFreeFallback(turns, systemMessage) {
        if (!this.onFallback) { this.onFallback = true; this.switchedAt = new Date().toISOString(); }
        console.log(`[${this.label}] using FREE fallback ${this.fName} (paid ${this.pName} exhausted until ${new Date(this.quotaUntil).toISOString()})`);
        const r = await this.fallback.sendRequest(turns, systemMessage);
        console.log(`[${this.label}] used FREE ${this.fName} (fallback)`);
        return r;
    }
}
