/**
 * fix106: voyager's step model is profile.model through selectAPI/createModel.
 * The deleted qwen3:4b on 192.168.1.215 is not a client constant, and a missing
 * code_model_free does not substitute qwen2.5-coder.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const HOME = './bots/icefox2000/home.json';
if (!existsSync(HOME)) {
    mkdirSync('./bots/icefox2000', { recursive: true });
    writeFileSync(HOME, JSON.stringify({ x: 0, y: 64, z: 0, groundVerified: true }));
}
if (process.env.OPENAI_API_KEY === undefined || process.env.OPENAI_API_KEY.length === 0) {
    process.env.OPENAI_API_KEY = 'test-key';
}

const { Voyager } = await import('../src/agent/voyager.js');
const { GPT } = await import('../src/models/gpt.js');
const { Ollama } = await import('../src/models/ollama.js');
const { CodeModel } = await import('../src/models/code_model.js');
const { Prompter } = await import('../src/models/prompter.js');
const { FailoverModel } = await import('../src/models/failover.js');
const { setSettings } = await import('../src/agent/settings.js');

function step(model) {
    const v = Object.create(Voyager.prototype);
    v.agent = { prompter: { profile: { model } } };
    return v._local();
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (err) { reject(err); }
        });
        req.on('error', reject);
    });
}

function ollamaReply() {
    return JSON.stringify({
        message: { role: 'assistant', content: '{}' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 1,
        prompt_eval_duration: 1000,
        eval_count: 1,
        eval_duration: 1000,
        total_duration: 3000,
        load_duration: 1000,
    });
}

function openaiReply() {
    return JSON.stringify({
        id: 'chatcmpl-fix106',
        object: 'chat.completion',
        created: 0,
        model: 'Qwen3.8-Flash-Next-UD-IQ4_XS',
        choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
    });
}

function listen() {
    const seen = [];
    const server = createServer(async (req, res) => {
        const body = await readJson(req);
        seen.push({ url: req.url, body });
        res.setHeader('Connection', 'close');
        res.setHeader('Content-Type', 'application/json');
        res.end(req.url.startsWith('/api/') ? ollamaReply() : openaiReply());
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
    });
}

function close(server) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

after(() => {
    for (const handle of process._getActiveHandles()) {
        const name = handle && handle.constructor && handle.constructor.name;
        if ((name === 'Agent' || name === 'HttpAgent' || name === 'HttpsAgent') && typeof handle.destroy === 'function') {
            handle.destroy();
        }
    }
});

const failover = {
    api: 'ollama',
    model: 'qwen2.5-coder:7b',
    url: 'http://192.168.1.215:11434',
    params: { keep_alive: -1 },
};

const dell = {
    api: 'openai',
    model: 'Qwen3.8-Flash-Next-UD-IQ4_XS',
    url: 'http://192.168.1.148:8090/v1',
    params: {
        chat_template_kwargs: { enable_thinking: false },
    },
    failover,
};

function assertNoCap(obj) {
    assert.equal(Object.hasOwn(obj, 'max_tokens'), false);
    assert.equal(Object.hasOwn(obj, 'max_completion_tokens'), false);
    assert.equal(Object.hasOwn(obj, 'num_ctx'), false);
    assert.equal(Object.hasOwn(obj, 'num_predict'), false);
    assert.equal(Object.hasOwn(obj, 'n_predict'), false);
}

describe('fix106: voyager step model comes from profile.model', () => {
    it('openai profile.model is the openai client, with a declared ollama failover and JSON mode on both', () => {
        const mo = JSON.parse(readFileSync(new URL('../profiles/mo_bot.json', import.meta.url), 'utf8'));
        assert.deepEqual(mo.model, dell);
        const before = structuredClone(mo.model);
        const model = step(mo.model);
        assert.equal(model instanceof FailoverModel, true);
        assert.equal(model.primary instanceof GPT, true);
        assert.equal(model.primary instanceof Ollama, false);
        assert.equal(model.failover instanceof Ollama, true);
        assert.equal(model.primary.model_name, dell.model);
        assert.equal(model.primary.url, dell.url);
        assert.deepEqual(model.primary.params.response_format, { type: 'json_object' });
        assert.deepEqual(model.primary.params.chat_template_kwargs, { enable_thinking: false });
        assert.equal(model.failover.model_name, failover.model);
        assert.equal(model.failover.url, failover.url);
        assert.equal(model.failover.params.format, 'json');
        assert.equal(model.failover.params.keep_alive, -1);
        assert.equal(Object.hasOwn(model.failover.params, 'num_ctx'), false);
        assert.equal(Object.hasOwn(model.failover.params, 'num_predict'), false);
        assert.deepEqual(mo.model.params, { chat_template_kwargs: { enable_thinking: false } });
        assert.deepEqual(mo.model.failover.params, { keep_alive: -1 });
        assertNoCap(model.primary.params);
        assert.equal(Object.hasOwn(model.primary.params, 'keep_alive'), false);
        assert.equal(Object.hasOwn(model.primary.params, 'format'), false);
        assert.deepEqual(mo.model, before);
    });

    it('ollama profile.model is Ollama, with format json, keep_alive, and the profile options', () => {
        const profileModel = {
            api: 'ollama',
            model: 'profile-model',
            url: 'http://127.0.0.1:9',
            params: { keep_alive: -1, options: { num_ctx: 8192, num_predict: 512 } },
        };
        const before = structuredClone(profileModel);
        const model = step(profileModel);
        assert.equal(model instanceof Ollama, true);
        assert.equal(model instanceof GPT, false);
        assert.equal(model.model_name, 'profile-model');
        assert.equal(model.url, 'http://127.0.0.1:9');
        assert.equal(model.params.format, 'json');
        assert.equal(model.params.keep_alive, -1);
        assert.deepEqual(model.params.options, { num_ctx: 8192, num_predict: 512 });
        assert.deepEqual(profileModel, before);
    });

    it('an openai request carries response_format and chat_template_kwargs and no keep_alive', async () => {
        const { server, seen, port } = await listen();
        try {
            const profileModel = {
                api: 'openai',
                model: dell.model,
                url: `http://127.0.0.1:${port}/v1`,
                params: dell.params,
            };
            const model = step(profileModel);
            assert.equal(model instanceof GPT, true);
            assert.equal(model.url, profileModel.url);
            const meta = { kind: 'curriculum', components: { system: 11, user: 13 }, requestId: 'curriculum#1' };
            const reply = await model.sendRequest([{ role: 'user', content: 'propose a task' }], 'return json', meta);
            assert.equal(reply, '{}');
            assert.equal(seen.length, 1);
            assert.equal(seen[0].url, '/v1/chat/completions');
            const body = seen[0].body;
            assert.equal(body.model, dell.model);
            assert.deepEqual(body.response_format, { type: 'json_object' });
            assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
            assertNoCap(body);
            assert.equal(Object.hasOwn(body, 'keep_alive'), false);
            assert.equal(Object.hasOwn(body, 'format'), false);
            assert.equal(Object.hasOwn(body, 'stop'), false);
            assert.equal(JSON.stringify(body).includes('[object Object]'), false);
            assert.equal(JSON.stringify(body).includes('"kind"'), false);
            assert.equal(body.messages.some((m) => String(m.content).includes('propose a task')), true);
        } finally {
            await close(server);
        }
    });

    it('an ollama request carries format json, keep_alive, and the profile generation options', async () => {
        const { server, seen, port } = await listen();
        try {
            const profileModel = {
                api: 'ollama',
                model: 'profile-model',
                url: `http://127.0.0.1:${port}`,
                params: { keep_alive: -1, options: { num_ctx: 8192, num_predict: 512 } },
            };
            const model = step(profileModel);
            assert.equal(model instanceof Ollama, true);
            assert.equal(model.url, profileModel.url);
            const reply = await model.sendRequest([{ role: 'user', content: 'propose a task' }], 'return json', { kind: 'curriculum', components: { system: 11, user: 13 } });
            assert.equal(reply, '{}');
            assert.equal(seen.length, 1);
            assert.equal(seen[0].url, '/api/chat');
            const body = seen[0].body;
            assert.equal(body.model, 'profile-model');
            assert.equal(body.format, 'json');
            assert.equal(body.keep_alive, -1);
            assert.deepEqual(body.options, { num_ctx: 8192, num_predict: 512 });
            assert.equal(Object.hasOwn(body, 'response_format'), false);
        } finally {
            await close(server);
        }
    });

    it('a missing or malformed profile.model throws', () => {
        const v = () => Object.create(Voyager.prototype);
        const missing = v();
        missing.agent = { prompter: { profile: {} } };
        assert.throws(() => missing._local(), /profile\.model is missing/);
        const nul = v();
        nul.agent = { prompter: { profile: { model: null } } };
        assert.throws(() => nul._local(), /profile\.model is missing/);
        assert.throws(() => step('qwen3:4b-instruct-2507-q4_K_M'), /profile\.model is malformed/);
        assert.throws(() => step({ api: 'openai', url: 'http://127.0.0.1:9', params: {} }), /profile\.model\.model is missing/);
        assert.throws(() => step({ model: 'Qwen3.8-Flash-Next-UD-IQ4_XS', url: dell.url, params: dell.params }), /profile\.model\.api is missing/);
        assert.throws(() => step({ api: 'openai', model: dell.model, params: dell.params }), /profile\.model\.url is missing/);
        assert.throws(() => step({ api: 'openai', model: dell.model, url: dell.url, params: [] }), /profile\.model\.params is malformed/);
        assert.throws(() => step({ ...dell, params: { ...dell.params, keep_alive: -1 } }), /keep_alive is only sent for api ollama/);
        assert.throws(() => step({ api: 'anthropic', model: 'claude-sonnet-4-6', url: 'http://127.0.0.1:9' }), /no JSON-mode mapping for api "anthropic"/);
    });

    it('voyager.js has no hardcoded step-model host or qwen3:4b name', () => {
        const src = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
        assert.equal(src.includes('192.168.'), false);
        assert.equal(src.includes('qwen3:4b'), false);
        assert.equal(src.includes('createStepModel'), true);
        const factory = readFileSync(new URL('../src/agent/step_model.js', import.meta.url), 'utf8');
        assert.equal(factory.includes('max_tokens'), false);
        assert.equal(factory.includes('num_ctx'), false);
        assert.equal(factory.includes('num_predict'), false);
    });
});

describe('fix106: code model is the Dell openai server and is not JSON mode', () => {
    const NAME = 'fix106-code-model';
    after(() => rmSync(`./bots/${NAME}`, { recursive: true, force: true }));

    it('mo_bot code_model matches model; embedding and code_model_free stay on .215', () => {
        const mo = JSON.parse(readFileSync(new URL('../profiles/mo_bot.json', import.meta.url), 'utf8'));
        assert.deepEqual(mo.code_model, mo.model);
        assert.deepEqual(mo.code_model, dell);
        assert.equal(mo.embedding.url, 'http://192.168.1.215:11434');
        assert.equal(mo.embedding.model, 'nomic-embed-text');
        assert.equal(mo.code_model_free.url, 'http://192.168.1.215:11434');
        assert.equal(mo.code_model_free.model, 'qwen2.5-coder:7b');
    });

    it('prompter builds api openai through the factory, and the request has no JSON mode or generation cap', async () => {
        const { server, seen, port } = await listen();
        const { default: agentSettings } = await import('../src/agent/settings.js');
        const saved = { ...agentSettings };
        setSettings({ base_profile: 'assistant' });
        try {
            const profile = {
                name: NAME,
                model: { api: 'ollama', model: 'chat-test', url: 'http://127.0.0.1:9', params: { keep_alive: -1 } },
                code_model: {
                    api: 'openai',
                    model: dell.model,
                    url: `http://127.0.0.1:${port}/v1`,
                    params: { chat_template_kwargs: { enable_thinking: false } },
                },
                embedding: { api: 'ollama', model: 'nomic-embed-text', url: 'http://127.0.0.1:9', params: { keep_alive: -1 } },
            };
            const prompter = new Prompter({ name: NAME }, profile);
            const coder = prompter.code_model;
            assert.equal(coder instanceof CodeModel, true);
            assert.equal(coder.primary instanceof GPT, true);
            assert.equal(coder.primary instanceof Ollama, false);
            assert.equal(coder.primary.model_name, dell.model);
            assert.equal(coder.primary.url, `http://127.0.0.1:${port}/v1`);
            assert.deepEqual(coder.primary.params, { chat_template_kwargs: { enable_thinking: false } });
            assert.equal(Object.hasOwn(coder.primary.params, 'response_format'), false);
            assert.equal(Object.hasOwn(coder.primary.params, 'format'), false);
            assertNoCap(coder.primary.params);
            const reply = await coder.sendRequest([{ role: 'user', content: 'write a codeblock' }], 'system');
            assert.equal(reply, '{}');
            assert.equal(seen.length, 1);
            assert.equal(seen[0].url, '/v1/chat/completions');
            const body = seen[0].body;
            assert.equal(body.model, dell.model);
            assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
            assert.equal(Object.hasOwn(body, 'response_format'), false);
            assert.equal(Object.hasOwn(body, 'format'), false);
            assert.equal(Object.hasOwn(body, 'keep_alive'), false);
            assertNoCap(body);
        } finally {
            setSettings(saved);
            await close(server);
        }
    });
});

describe('fix106: prompter does not substitute a coder when code_model_free is missing', () => {
    const NAME = 'fix106-prompter';
    after(() => rmSync(`./bots/${NAME}`, { recursive: true, force: true }));

    it('a cursor code model with no code_model_free throws', async () => {
        const src = readFileSync(new URL('../src/models/prompter.js', import.meta.url), 'utf8');
        assert.equal(src.includes('192.168.1.215'), false);
        assert.equal(src.includes('qwen2.5-coder'), false);
        const { default: agentSettings } = await import('../src/agent/settings.js');
        const saved = { ...agentSettings };
        setSettings({ base_profile: 'assistant' });
        try {
            const profile = {
                name: NAME,
                model: { api: 'ollama', model: 'chat-test', url: 'http://127.0.0.1:9', params: { keep_alive: -1 } },
                code_model: { api: 'cursor', model: 'composer-2.5' },
                embedding: { api: 'ollama', model: 'nomic-embed-text', url: 'http://127.0.0.1:9', params: { keep_alive: -1 } },
            };
            assert.throws(() => new Prompter({ name: NAME }, profile), /profile\.code_model_free is missing or malformed/);
        } finally {
            setSettings(saved);
        }
    });
});
