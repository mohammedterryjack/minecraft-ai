// Minimal OpenAI client for the code-model backup: unlike gpt.js it never swallows errors,
// so quota/429 and other failures reach CodeModelWithFallback and are handled loudly.
import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class OpenAIStrict {
    constructor(model_name, params = {}) {
        this.model_name = model_name;
        this.params = params;
        this.openai = new OpenAIApi({ apiKey: getKey('OPENAI_API_KEY'), maxRetries: 0 });
    }
    async sendRequest(turns, systemMessage) {
        const t0 = Date.now();
        const response = await this.openai.responses.create({
            model: this.model_name,
            instructions: systemMessage,
            input: strictFormat(turns),
            ...this.params,
        });
        console.log(`[openai] ${this.model_name} ok in ${Date.now() - t0}ms`);
        return response.output_text;
    }
}
