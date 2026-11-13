/**
 * fix107: a Dell connection reset must throw, not become the text
 * "My brain disconnected, try again." A profile may declare a failover model.
 * Only connection-class errors switch. Recovery is the next call to the primary.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';

if (process.env.OPENAI_API_KEY === undefined || process.env.OPENAI_API_KEY.length === 0) {
    process.env.OPENAI_API_KEY = 'test-key';
}
if (process.env.GEMINI_API_KEY === undefined || process.env.GEMINI_API_KEY.length === 0) {
    process.env.GEMINI_API_KEY = 'test-key';
}

const OpenAI = (await import('openai')).default;
const { GPT } = await import('../src/models/gpt.js');
const { Ollama } = await import('../src/models/ollama.js');
const { Gemini } = await import('../src/models/gemini.js');
const { FailoverModel, connectionErrorCode, isConnectionError } = await import('../src/models/failover.js');
const { createModel, selectAPI } = await import('../src/models/_model_map.js');
const { createStepModel } = await import('../src/agent/step_model.js');
const { CodeModel } = await import('../src/models/code_model.js');
const { Prompter } = await import('../src/models/prompter.js');
const settingsMod = await import('../src/agent/settings.js');
const { setSettings } = settingsMod;

const FAILOVER = {
    api: 'ollama',
    model: 'qwen2.5-coder:7b',
    url: 'http://192.168.1.215:11434',
    params: { keep_alive: -1 },
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function listen(handler) {
    const server = createServer((req, res) => {
        req.on('error', () => {});
        if (req.socket) req.socket.on('error', () => {});
        handler(req, res);
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function close(server) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

function openaiReply(text) {
    return JSON.stringify({
        id: 'chatcmpl-fix107',
        object: 'chat.completion',
        created: 0,
        model: 'Qwen3.8-Flash-Next-UD-IQ4_XS',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    });
}

function ollamaReply(text) {
    return JSON.stringify({
        message: { role: 'assistant', content: text },
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

function noRetry(gpt) {
    gpt.openai.maxRetries = 0;
    gpt.openai.timeout = 5000;
}

function resetSocket(req) {
    req.resume();
    req.socket.destroy();
}

async function capture(fn) {
    const lines = [];
    const orig = console.error;
    console.error = (...parts) => { lines.push(parts.map((part) => String(part)).join(' ')); };
    try {
        const result = await fn();
        return { result, lines, error: undefined };
    } catch (error) {
        return { result: undefined, lines, error };
    } finally {
        console.error = orig;
    }
}

function codeError(code) {
    const err = new Error(code);
    err.code = code;
    return err;
}

function fake(name, url, behavior) {
    const model = {
        model_name: name,
        url,
        calls: 0,
        async sendRequest(...args) {
            model.calls += 1;
            model.args = args;
            return behavior(model.calls, args);
        },
    };
    return model;
}

function switched(lines) {
    return lines.filter((line) => line.startsWith('!!! [failover] switching'));
}

after(() => {
    for (const handle of process._getActiveHandles()) {
        const name = handle && handle.constructor && handle.constructor.name;
        if ((name === 'Agent' || name === 'HttpAgent' || name === 'HttpsAgent') && typeof handle.destroy === 'function') {
            handle.destroy();
        }
    }
});

describe('fix107: connection errors are classified by type and code', () => {
    it('names system codes, the exact socket hang up message, and the OpenAI connection classes', () => {
        for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH']) {
            assert.equal(connectionErrorCode(codeError(code)), code);
        }
        assert.equal(connectionErrorCode(new Error('socket hang up')), 'socket hang up');
        assert.equal(isConnectionError(new Error('read ECONNRESET')), false);
        assert.equal(isConnectionError(new Error('prefix socket hang up suffix')), false);
        const cause = codeError('ECONNRESET');
        const sdk = new OpenAI.APIConnectionError({ cause });
        assert.equal(connectionErrorCode(sdk), 'ECONNRESET');
        const wrapped = new Error('[openai] request failed: Connection error.', { cause: sdk });
        assert.equal(connectionErrorCode(wrapped), 'ECONNRESET');
        assert.equal(connectionErrorCode(new OpenAI.APIConnectionError({ message: 'Connection error.' })), 'APIConnectionError');
        assert.equal(connectionErrorCode(new OpenAI.APIConnectionTimeoutError()), 'APIConnectionTimeoutError');
        assert.equal(isConnectionError(new OpenAI.APIUserAbortError()), false);
        assert.equal(isConnectionError(new OpenAI.BadRequestError(400, { message: 'bad', code: 'invalid_request' }, 'bad', {})), false);
        assert.equal(isConnectionError(Object.assign(new Error('500 exploded'), { status: 500 })), false);
        assert.equal(isConnectionError(new Error('Context length exceeded')), false);
        assert.equal(isConnectionError(Object.assign(new Error('context'), { code: 'context_length_exceeded' })), false);
    });
});

describe('fix107: gpt.js throws the provider error instead of a fake reply', () => {
    it('an APIConnectionError is thrown with the SDK error as cause', async () => {
        const gpt = new GPT('test-model', 'http://127.0.0.1:9/v1', {});
        const cause = codeError('ECONNRESET');
        const sdk = new OpenAI.APIConnectionError({ message: 'Connection error.', cause });
        gpt.openai = { chat: { completions: { create: async () => { throw sdk; } } } };
        const { error } = await capture(() => gpt.sendRequest([{ role: 'user', content: 'hi' }], 'sys'));
        assert.ok(error instanceof Error);
        assert.equal(error.cause, sdk);
        assert.equal(isConnectionError(error), true);
        assert.equal(error.message.includes('My brain disconnected'), false);
        assert.equal(error.message.includes('Vision is only supported'), false);
    });

    it('an image_url failure is thrown, not a vision sentence', async () => {
        const gpt = new GPT('test-model', 'http://127.0.0.1:9/v1', {});
        const sdk = new Error('image_url is not supported');
        gpt.openai = { chat: { completions: { create: async () => { throw sdk; } } } };
        const { error, result } = await capture(() => gpt.sendRequest([{ role: 'user', content: 'hi' }], 'sys'));
        assert.equal(result, undefined);
        assert.equal(error.cause, sdk);
        assert.equal(isConnectionError(error), false);
    });

    it('context length still retries with a shorter turn list and does not return text on the final failure', async () => {
        const gpt = new GPT('test-model', 'http://127.0.0.1:9/v1', {});
        const seen = [];
        gpt.openai = { chat: { completions: { create: async (pack) => {
            seen.push(pack.messages.map((message) => message.content).join('\n'));
            if (seen.length === 1) throw new Error('Context length exceeded');
            return { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] };
        } } } };
        const reply = await gpt.sendRequest([
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
        ], 'system');
        assert.equal(reply, '{"ok":true}');
        assert.equal(seen.length, 2);
        assert.equal(seen[0].includes('first'), true);
        assert.equal(seen[0].includes('second'), true);
        assert.equal(seen[1].includes('second'), true);
        assert.equal(seen[1].includes('first'), false);

        gpt.openai = { chat: { completions: { create: async () => { throw new Error('Context length exceeded'); } } } };
        const { error } = await capture(() => gpt.sendRequest([{ role: 'user', content: 'only' }], 'system'));
        assert.equal(error.cause.message, 'Context length exceeded');
        assert.equal(error.message.includes('My brain disconnected'), false);
    });

    it('a local server reset is a connection error, not a fake reply', async () => {
        const server = await listen((req) => { resetSocket(req); });
        try {
            const port = server.address().port;
            const gpt = new GPT('test-model', `http://127.0.0.1:${port}/v1`, {});
            noRetry(gpt);
            const { error, result } = await capture(() => gpt.sendRequest([{ role: 'user', content: 'hi' }], 'sys'));
            assert.equal(result, undefined);
            assert.ok(error instanceof Error, 'sendRequest resolved');
            assert.equal(error.message.includes('My brain disconnected'), false, error.message);
            assert.equal(isConnectionError(error), true, `${error.name} ${error.message} cause=${error.cause && error.cause.name} code=${error.cause && error.cause.code}`);
            assert.equal(error.cause instanceof OpenAI.APIConnectionError, true);
        } finally {
            await close(server);
        }
    });
});

describe('fix107: the factory wrapper fails over only on connection errors', () => {
    it('ECONNRESET switches, logs the model and code, and returns the failover reply', async () => {
        const primary = fake('Qwen3.8-Flash-Next-UD-IQ4_XS', 'http://192.168.1.148:8090/v1', () => { throw codeError('ECONNRESET'); });
        const failover = fake('qwen2.5-coder:7b', 'http://192.168.1.215:11434', () => '{"task":"dig"}');
        const model = new FailoverModel(primary, failover);
        const seen = await capture(() => model.sendRequest([{ role: 'user', content: 'hi' }], 'sys', { kind: 'curriculum' }));
        assert.equal(seen.error, undefined);
        assert.equal(seen.result, '{"task":"dig"}');
        assert.equal(primary.calls, 1);
        assert.equal(failover.calls, 1);
        assert.equal(model.onFailover, true);
        assert.deepEqual(failover.args[2], { kind: 'curriculum' });
        assert.equal(switched(seen.lines).length, 1);
        const line = switched(seen.lines)[0];
        assert.equal(line.includes('Qwen3.8-Flash-Next-UD-IQ4_XS'), true, line);
        assert.equal(line.includes('http://192.168.1.148:8090/v1'), true, line);
        assert.equal(line.includes('qwen2.5-coder:7b'), true, line);
        assert.equal(line.includes('http://192.168.1.215:11434'), true, line);
        assert.equal(line.includes('after ECONNRESET'), true, line);
    });

    it('APIConnectionError and APIConnectionTimeoutError switch and log the class', async () => {
        for (const [thrown, code] of [
            [new OpenAI.APIConnectionError({ message: 'Connection error.' }), 'APIConnectionError'],
            [new OpenAI.APIConnectionTimeoutError(), 'APIConnectionTimeoutError'],
            [new Error('socket hang up'), 'socket hang up'],
        ]) {
            const primary = fake('primary-model', 'http://primary.example/v1', () => { throw thrown; });
            const failover = fake('failover-model', 'http://failover.example', () => 'ok');
            const model = new FailoverModel(primary, failover);
            const seen = await capture(() => model.sendRequest([], 'sys'));
            assert.equal(seen.result, 'ok');
            assert.equal(failover.calls, 1);
            assert.equal(switched(seen.lines)[0].includes(`after ${code}`), true, seen.lines.join('\n'));
        }
    });

    it('a non-connection error, including a message that merely mentions ECONNRESET, does not fail over', async () => {
        for (const thrown of [
            new Error('local model reply is not valid JSON'),
            new Error('read ECONNRESET'),
            Object.assign(new Error('400 bad'), { status: 400 }),
            new Error('Context length exceeded'),
        ]) {
            const primary = fake('primary-model', 'http://primary.example/v1', () => { throw thrown; });
            const failover = fake('failover-model', 'http://failover.example', () => 'should-not-run');
            const model = new FailoverModel(primary, failover);
            const seen = await capture(() => model.sendRequest([], 'sys'));
            assert.equal(seen.error, thrown);
            assert.equal(failover.calls, 0);
            assert.equal(model.onFailover, false);
            assert.equal(switched(seen.lines).length, 0);
        }
    });

    it('the next call probes the primary and logs primary recovered', async () => {
        let down = true;
        const primary = fake('primary-model', 'http://primary.example/v1', () => {
            if (down) throw codeError('ECONNREFUSED');
            return 'from-primary';
        });
        const failover = fake('failover-model', 'http://failover.example', () => 'from-failover');
        const model = new FailoverModel(primary, failover);
        const first = await capture(() => model.sendRequest([], 'sys'));
        assert.equal(first.result, 'from-failover');
        assert.equal(model.onFailover, true);
        down = false;
        const second = await capture(() => model.sendRequest([], 'sys'));
        assert.equal(second.result, 'from-primary');
        assert.equal(model.onFailover, false);
        assert.equal(second.lines.some((line) => line.startsWith('!!! [failover] primary recovered ')), true, second.lines.join('\n'));
        assert.equal(second.lines.some((line) => line.includes('primary-model') && line.includes('http://primary.example/v1')), true);
        assert.equal(failover.calls, 1);
        const third = await capture(() => model.sendRequest([], 'sys'));
        assert.equal(third.result, 'from-primary');
        assert.equal(third.lines.some((line) => line.includes('primary recovered')), false);
        assert.equal(failover.calls, 1);
        assert.equal(primary.calls, 3);
    });

    it('a failed probe stays on the failover, and a non-connection probe does not call it', async () => {
        let mode = 'down';
        const primary = fake('primary-model', 'http://primary.example/v1', () => {
            if (mode === 'down') throw codeError('EHOSTUNREACH');
            if (mode === 'bad') throw new Error('invalid JSON');
            return 'up';
        });
        const failover = fake('failover-model', 'http://failover.example', () => 'standby');
        const model = new FailoverModel(primary, failover);
        await capture(() => model.sendRequest([], 'sys'));
        const still = await capture(() => model.sendRequest([], 'sys'));
        assert.equal(still.result, 'standby');
        assert.equal(model.onFailover, true);
        assert.equal(still.lines.some((line) => line.includes('still unreachable (EHOSTUNREACH)')), true, still.lines.join('\n'));
        assert.equal(switched(still.lines).length, 0);
        mode = 'bad';
        const bad = await capture(() => model.sendRequest([], 'sys'));
        assert.equal(bad.error.message, 'invalid JSON');
        assert.equal(failover.calls, 2);
        assert.equal(model.onFailover, true);
    });

    it('when the failover also fails, the throw carries both errors', async () => {
        const primaryErr = codeError('ETIMEDOUT');
        const failoverErr = new Error('failover reply is not valid JSON');
        const primary = fake('primary-model', 'http://primary.example/v1', () => { throw primaryErr; });
        const failover = fake('failover-model', 'http://failover.example', () => { throw failoverErr; });
        const model = new FailoverModel(primary, failover);
        const seen = await capture(() => model.sendRequest([], 'sys'));
        assert.ok(seen.error instanceof AggregateError);
        assert.equal(seen.error.errors[0], primaryErr);
        assert.equal(seen.error.errors[1], failoverErr);
        assert.equal(seen.error.cause, primaryErr);
        assert.equal(seen.error.message.startsWith('!!! [failover]'), true, seen.error.message);
        assert.equal(seen.error.message.includes('ETIMEDOUT'), true, seen.error.message);
        assert.equal(seen.error.message.includes('failover reply is not valid JSON'), true, seen.error.message);
        assert.equal(seen.lines.some((line) => line === seen.error.message), true);
    });

    it('embed uses the same connection switch', async () => {
        const primary = {
            model_name: 'primary-model',
            url: 'http://primary.example/v1',
            calls: 0,
            async embed() {
                this.calls += 1;
                throw codeError('ECONNRESET');
            },
        };
        const failover = {
            model_name: 'failover-model',
            url: 'http://failover.example',
            calls: 0,
            async embed(text) {
                this.calls += 1;
                return [text.length];
            },
        };
        const model = new FailoverModel(primary, failover);
        const seen = await capture(() => model.embed('hi'));
        assert.deepEqual(seen.result, [2]);
        assert.equal(failover.calls, 1);
        assert.equal(switched(seen.lines)[0].includes('after ECONNRESET'), true);
        const bare = new FailoverModel(
            { model_name: 'primary-model', url: 'http://primary.example/v1', async sendRequest() { return 'x'; } },
            { model_name: 'failover-model', url: 'http://failover.example', async sendRequest() { return 'y'; } },
        );
        await assert.rejects(() => bare.embed('hi'), /has no embed/);
    });
});

describe('fix107: failover is only the spec the profile declares', () => {
    it('a profile with no failover throws the connection error and builds no second model', async () => {
        const server = await listen((req) => { resetSocket(req); });
        try {
            const port = server.address().port;
            const model = createModel({ api: 'openai', model: 'plain-model', url: `http://127.0.0.1:${port}/v1` });
            assert.equal(model instanceof GPT, true);
            assert.equal(model instanceof FailoverModel, false);
            assert.equal(model instanceof Ollama, false);
            noRetry(model);
            const seen = await capture(() => model.sendRequest([{ role: 'user', content: 'hi' }], 'sys'));
            assert.ok(seen.error instanceof Error);
            assert.equal(isConnectionError(seen.error), true, seen.error.message);
            assert.equal(seen.error.message.includes('qwen2.5-coder'), false);
            assert.equal(switched(seen.lines).length, 0);
        } finally {
            await close(server);
        }
    });

    it('mo_bot declares the ollama coder for the Dell chat, step, and code models', () => {
        const mo = JSON.parse(readFileSync(new URL('../profiles/mo_bot.json', import.meta.url), 'utf8'));
        assert.deepEqual(mo.model.failover, FAILOVER);
        assert.deepEqual(mo.code_model.failover, FAILOVER);
        assert.equal(Object.hasOwn(mo.embedding, 'failover'), false);
        assert.equal(Object.hasOwn(mo.code_model_free, 'failover'), false);
        assert.equal(Object.hasOwn(mo.vision_model, 'failover'), false);
        assert.equal(Object.hasOwn(FAILOVER.params, 'num_ctx'), false);
        assert.equal(Object.hasOwn(FAILOVER.params, 'num_predict'), false);
        const before = structuredClone(mo.model);
        const chat = createModel(selectAPI(structuredClone(mo.model)));
        assert.equal(chat instanceof FailoverModel, true);
        assert.equal(chat.primary instanceof GPT, true);
        assert.equal(chat.failover instanceof Ollama, true);
        assert.equal(chat.failover.model_name, 'qwen2.5-coder:7b');
        assert.equal(chat.failover.url, FAILOVER.url);
        assert.equal(chat.failover.params.keep_alive, -1);
        assert.equal(Object.hasOwn(chat.failover.params, 'format'), false);
        assert.equal(Object.hasOwn(chat.primary.params, 'response_format'), false);
        const stepSpec = structuredClone(mo.model);
        const step = createStepModel(stepSpec);
        assert.equal(step instanceof FailoverModel, true);
        assert.deepEqual(step.primary.params.response_format, { type: 'json_object' });
        assert.equal(step.failover.params.format, 'json');
        assert.equal(step.failover.params.keep_alive, -1);
        assert.equal(Object.hasOwn(step.failover.params, 'num_ctx'), false);
        assert.equal(Object.hasOwn(step.primary.params, 'num_predict'), false);
        assert.deepEqual(stepSpec, before);
        assert.deepEqual(mo.model, before);
    });

    it('a missing or malformed failover is not replaced with a model', () => {
        assert.throws(
            () => createModel({ api: 'openai', model: 'm', url: 'http://127.0.0.1:9/v1', failover: null }),
            /failover is malformed/,
        );
        assert.throws(
            () => createStepModel({
                api: 'openai',
                model: 'm',
                url: 'http://127.0.0.1:9/v1',
                failover: { api: 'ollama', model: 'qwen2.5-coder:7b' },
            }),
            /profile\.model\.failover\.url is missing/,
        );
    });

    it('the step model sends format json on the ollama failover and returns to the primary', async () => {
        let primaryUp = false;
        const primarySeen = [];
        const failoverSeen = [];
        const primary = await listen(async (req, res) => {
            if (!primaryUp) {
                resetSocket(req);
                return;
            }
            primarySeen.push(JSON.parse(await readBody(req)));
            res.setHeader('content-type', 'application/json');
            res.end(openaiReply('{"from":"primary"}'));
        });
        const standby = await listen(async (req, res) => {
            failoverSeen.push(JSON.parse(await readBody(req)));
            res.setHeader('content-type', 'application/json');
            res.end(ollamaReply('{"from":"failover"}'));
        });
        try {
            const model = createStepModel({
                api: 'openai',
                model: 'Qwen3.8-Flash-Next-UD-IQ4_XS',
                url: `http://127.0.0.1:${primary.address().port}/v1`,
                params: { chat_template_kwargs: { enable_thinking: false } },
                failover: {
                    api: 'ollama',
                    model: 'qwen2.5-coder:7b',
                    url: `http://127.0.0.1:${standby.address().port}`,
                    params: { keep_alive: -1 },
                },
            });
            noRetry(model.primary);
            const first = await capture(() => model.sendRequest([{ role: 'user', content: 'propose' }], 'return json', { kind: 'curriculum' }));
            assert.equal(first.error, undefined, first.error && first.error.stack);
            assert.equal(first.result, '{"from":"failover"}');
            assert.equal(failoverSeen.length, 1);
            assert.equal(failoverSeen[0].model, 'qwen2.5-coder:7b');
            assert.equal(failoverSeen[0].format, 'json');
            assert.equal(failoverSeen[0].keep_alive, -1);
            assert.equal(Object.hasOwn(failoverSeen[0], 'num_ctx'), false);
            assert.equal(Object.hasOwn(failoverSeen[0], 'num_predict'), false);
            assert.equal(Object.hasOwn(failoverSeen[0], 'max_tokens'), false);
            assert.equal(Object.hasOwn(failoverSeen[0], 'response_format'), false);
            assert.equal(switched(first.lines).length, 1, first.lines.join('\n'));
            assert.equal(first.lines.some((line) => line.includes('after ECONNRESET') || line.includes('after APIConnectionError') || line.includes('after socket hang up')), true, first.lines.join('\n'));
            primaryUp = true;
            const second = await capture(() => model.sendRequest([{ role: 'user', content: 'propose' }], 'return json', { kind: 'curriculum' }));
            assert.equal(second.result, '{"from":"primary"}', second.error && second.error.stack);
            assert.equal(second.lines.some((line) => line.startsWith('!!! [failover] primary recovered ')), true, second.lines.join('\n'));
            assert.equal(primarySeen.length, 1);
            assert.deepEqual(primarySeen[0].response_format, { type: 'json_object' });
            assert.equal(Object.hasOwn(primarySeen[0], 'format'), false);
            assert.equal(failoverSeen.length, 1);
        } finally {
            await close(primary);
            await close(standby);
        }
    });

    it('chat failover does not add JSON mode, and HTTP 400 does not switch', async () => {
        const primarySeen = [];
        const failoverSeen = [];
        let status = 400;
        const primary = await listen(async (req, res) => {
            primarySeen.push(JSON.parse(await readBody(req)));
            res.statusCode = status;
            res.setHeader('content-type', 'application/json');
            if (status === 200) res.end(openaiReply('chat-ok'));
            else res.end(JSON.stringify({ error: { message: 'bad', type: 'invalid_request_error', code: 'invalid_request' } }));
        });
        const standby = await listen(async (req, res) => {
            failoverSeen.push(JSON.parse(await readBody(req)));
            res.setHeader('content-type', 'application/json');
            res.end(ollamaReply('should-not-run'));
        });
        try {
            const model = createModel(selectAPI({
                api: 'openai',
                model: 'Qwen3.8-Flash-Next-UD-IQ4_XS',
                url: `http://127.0.0.1:${primary.address().port}/v1`,
                params: { chat_template_kwargs: { enable_thinking: false } },
                failover: {
                    api: 'ollama',
                    model: 'qwen2.5-coder:7b',
                    url: `http://127.0.0.1:${standby.address().port}`,
                    params: { keep_alive: -1 },
                },
            }));
            noRetry(model.primary);
            const failed = await capture(() => model.sendRequest([{ role: 'user', content: 'write code' }], 'sys'));
            assert.ok(failed.error instanceof Error);
            assert.equal(isConnectionError(failed.error), false, failed.error.message);
            assert.equal(failoverSeen.length, 0);
            assert.equal(switched(failed.lines).length, 0);
            assert.equal(model.onFailover, false);
            status = 200;
            const ok = await capture(() => model.sendRequest([{ role: 'user', content: 'write code' }], 'sys'));
            assert.equal(ok.result, 'chat-ok');
            assert.equal(failoverSeen.length, 0);
            assert.equal(Object.hasOwn(primarySeen[0], 'response_format'), false);
            assert.equal(Object.hasOwn(primarySeen[0], 'format'), false);
        } finally {
            await close(primary);
            await close(standby);
        }
    });
});

describe('fix107: profile models do not swallow errors into text', () => {
    it('gpt, ollama, and gemini source no longer return the canned replies', () => {
        const gpt = readFileSync(new URL('../src/models/gpt.js', import.meta.url), 'utf8');
        const ollama = readFileSync(new URL('../src/models/ollama.js', import.meta.url), 'utf8');
        const gemini = readFileSync(new URL('../src/models/gemini.js', import.meta.url), 'utf8');
        assert.equal(gpt.includes('My brain disconnected'), false);
        assert.equal(gpt.includes('Vision is only supported'), false);
        assert.equal(ollama.includes('No response data.'), false);
        assert.equal(ollama.includes('I thought too hard'), false);
        assert.equal(gemini.includes('Vision is only supported'), false);
        assert.equal(gemini.includes('An unexpected error occurred, please try again.'), false);
        for (const rel of ['src/models/failover.js', 'src/models/_model_map.js', 'src/agent/step_model.js', 'src/models/gpt.js', 'src/models/prompter.js']) {
            const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
            assert.equal(src.includes('192.168.'), false, rel);
        }
    });

    it('gemini vision throws the provider error', async () => {
        const gemini = new Gemini('gemini-3.5-flash-lite');
        const sdk = new Error('Image input modality is not enabled for models/gemini');
        gemini.genAI = { models: { generateContent: async () => { throw sdk; } } };
        const seen = await capture(() => gemini.sendVisionRequest([], 'look', Buffer.from('x')));
        assert.equal(seen.result, undefined);
        assert.equal(seen.error.cause, sdk);
        assert.equal(seen.error.message.includes('please try again'), false);
    });
});

describe('fix107: prompter chat and code models both get the wrapper', () => {
    const NAME = 'fix107-prompter';
    after(() => rmSync(`./bots/${NAME}`, { recursive: true, force: true }));

    it('chat and code_model are failover wrappers and embedding is not', () => {
        const saved = { ...settingsMod.default };
        setSettings({ base_profile: 'assistant' });
        try {
            const profile = {
                name: NAME,
                model: {
                    api: 'openai',
                    model: 'chat-model',
                    url: 'http://127.0.0.1:9/v1',
                    failover: { api: 'ollama', model: 'qwen2.5-coder:7b', url: 'http://127.0.0.1:9', params: { keep_alive: -1 } },
                },
                code_model: {
                    api: 'openai',
                    model: 'code-model',
                    url: 'http://127.0.0.1:9/v1',
                    failover: { api: 'ollama', model: 'qwen2.5-coder:7b', url: 'http://127.0.0.1:9', params: { keep_alive: -1 } },
                },
                embedding: { api: 'ollama', model: 'nomic-embed-text', url: 'http://127.0.0.1:9' },
            };
            const prompter = new Prompter({ name: NAME }, profile);
            assert.equal(prompter.chat_model instanceof CodeModel, true);
            assert.equal(prompter.chat_model.primary instanceof FailoverModel, true);
            assert.equal(prompter.chat_model.primary.primary instanceof GPT, true);
            assert.equal(prompter.chat_model.primary.failover instanceof Ollama, true);
            assert.equal(Object.hasOwn(prompter.chat_model.primary.failover.params, 'format'), false);
            assert.equal(prompter.code_model instanceof CodeModel, true);
            assert.equal(prompter.code_model.primary instanceof FailoverModel, true);
            assert.equal(prompter.code_model.primary.primary.model_name, 'code-model');
            assert.equal(prompter.embedding_model instanceof Ollama, true);
            assert.equal(prompter.embedding_model instanceof FailoverModel, false);
        } finally {
            setSettings(saved);
        }
    });
});
