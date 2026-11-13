import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import { errorWithCause } from './failover.js';

// A string third argument is the chat stop sequence. Voyager's step model passes an
// inference-meta object in that position (the same call Ollama reads for timing). That
// object is not a stop sequence and must not be written into the request.
function stopSequence(third) {
    if (third === undefined) return '***';
    if (typeof third === 'string') return third;
    if (third !== null && typeof third === 'object') return undefined;
    throw new Error(`[openai] stop sequence must be a string, got ${third === null ? 'null' : typeof third}`);
}

// Our own 'Context length exceeded' throw, or the API's context_length_exceeded code.
// This retries with a shorter turn list. It does not invent a text reply.
function isContextLength(err) {
    if (err instanceof Error && err.message === 'Context length exceeded') return true;
    if (err !== null && typeof err === 'object' && err.code === 'context_length_exceeded') return true;
    return false;
}

export class GPT {
    static prefix = 'openai';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url; // store so that we know whether a custom URL has been set

        let config = {};
        if (url)
            config.baseURL = url;

        if (hasKey('OPENAI_ORG_ID'))
            config.organization = getKey('OPENAI_ORG_ID');

        config.apiKey = getKey('OPENAI_API_KEY');

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='***') {
        const stop = stopSequence(stop_seq);
        let messages = strictFormat(turns);
        if (stop !== undefined) {
            messages = messages.map(message => {
                message.content += stop;
                return message;
            });
        }
        let model = this.model_name || "gpt-5.4-mini";

        let res = null;

        try {
            console.log('Awaiting openai api response from model', model);
            // if a custom URL is set, use chat.completions
            // because custom "OpenAI-compatible" endpoints likely do not have responses endpoint
            if (this.url) {
                let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);
                messages = strictFormat(messages);
                const pack = {
                    model: model,
                    messages,
                    ...(stop === undefined ? {} : { stop }),
                    ...(this.params || {})
                };
                if (model.includes('o1') || model.includes('o3') || model.includes('5')) {
                    delete pack.stop;
                }
                let completion = await this.openai.chat.completions.create(pack);
                if (completion.choices[0].finish_reason == 'length')
                    throw new Error('Context length exceeded'); 
                console.log('Received.');
                res = completion.choices[0].message.content;
            } 
            // otherwise, use responses
            else {
                let messages = strictFormat(turns);
                if (stop !== undefined) {
                    messages = messages.map(message => {
                        message.content += stop;
                        return message;
                    });
                }
                const response = await this.openai.responses.create({
                    model: model,
                    instructions: systemMessage,
                    input: messages,
                    ...(this.params || {})
                });
                console.log('Received.');
                res = response.output_text;
                if (stop !== undefined) {
                    let stop_seq_index = res.indexOf(stop);
                    res = stop_seq_index !== -1 ? res.slice(0, stop_seq_index) : res;
                }
            }
        }
        catch (err) {
            if (isContextLength(err) && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            }
            // OpenAI Node SDK connection failures are APIConnectionError /
            // APIConnectionTimeoutError (https://github.com/openai/openai-node#handling-errors).
            // The original error is the cause. A text substitute was parsed as the
            // model reply ("local model reply is not valid JSON").
            const detail = err instanceof Error ? err.message : String(err);
            throw errorWithCause(err, `[openai] ${model} request failed: ${detail}`);
        }
        return res;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "input_text", text: systemMessage },
                {
                    type: "input_image",
                    image_url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        if (text.length > 8191)
            text = text.slice(0, 8191);
        const embedding = await this.openai.embeddings.create({
            model: this.model_name || "text-embedding-3-small",
            input: text,
            encoding_format: "float",
        });
        return embedding.data[0].embedding;
    }

}

const sendAudioRequest = async (text, model, voice, url) => {
    const payload = {
        model: model,
        voice: voice,
        input: text
    }

    let config = {};

    if (url)
        config.baseURL = url;

    if (hasKey('OPENAI_ORG_ID'))
        config.organization = getKey('OPENAI_ORG_ID');

    config.apiKey = getKey('OPENAI_API_KEY');

    const openai = new OpenAIApi(config);

    const mp3 = await openai.audio.speech.create(payload);
    const buffer = Buffer.from(await mp3.arrayBuffer());
    const base64 = buffer.toString("base64");
    return base64;
}

export const TTSConfig = {
    sendAudioRequest: sendAudioRequest,
    baseUrl: 'https://api.openai.com/v1',
}
