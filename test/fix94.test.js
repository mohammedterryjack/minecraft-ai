// fix94: a refusal waits for the backend's own Done line and exits 75 once;
// an Ollama context overflow throws, and the prompt is cut to the model's context before send.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { mkdtemp, writeFile, appendFile, rename, rm, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { armBackendReady, requireBackendLogDir, configuredLink } from '../src/process/backend_ready.js';
import {
    classifyBackendRefusal, latchDisconnect, applyDisconnect, latchBackendStopping,
    resumeWhenBackendReady, parentExitForChild, launchdWouldRestart, EXIT_BACKEND_READY,
} from '../src/process/backend_unavailable.js';
import { parseContextOverflow, chatSectionSizes } from '../src/agent/prompt_cut.js';
import { Ollama, NEVER_CUT_PROMPT } from '../src/models/ollama.js';
import { setCallDurationStore } from '../src/models/call_durations.js';

const POLICY = { successfulExit: false };
const DONE = '[12:06:01] [Server thread/INFO]: Done (2.5s)!\n';
const OLD_DONE = '[12:05:38] [Server thread/INFO]: Done (146.414s)!\n';
const START = '[12:04:00] [Server thread/INFO]: Starting minecraft server version 1.21.4\n';

function listen(handler) {
    const server = http.createServer(handler);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function chatReply(content) {
    return JSON.stringify({
        message: { content },
        done_reason: 'stop',
        prompt_eval_count: 4,
        prompt_eval_duration: 1000,
        eval_count: 1,
        eval_duration: 1000,
        total_duration: 3000,
        load_duration: 0,
    });
}

describe('fix94 backend ready', () => {
    it('an old Done is not readiness; rotation to a new latest.log Done exits 75 once', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix94-'));
        const latest = path.join(dir, 'latest.log');
        await writeFile(latest, START + OLD_DONE + '[12:05:40] [Server thread/INFO]: Stopping server\n');
        const latch = { latched: false };
        const refusal = 'AnnotatedConnectException finishConnect(..) failed with error(-61): Connection refused: /10.9.8.7:40000';
        latchDisconnect(latch, 'kicked', refusal);
        const handle = armBackendReady({ logDir: dir });
        let settled = false;
        handle.ready.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        assert.strictEqual(settled, false, 'a Done followed by Stopping server is not the current run');
        const exits = [];
        const logs = [];
        const pending = resumeWhenBackendReady({
            logDir: dir,
            latch,
            watch: handle,
            exitFn: (code) => exits.push(code),
            log: (msg) => logs.push(msg),
        });
        assert.deepStrictEqual(exits, []);
        await rename(latest, path.join(dir, '2026-11-09-1.log'));
        await writeFile(latest, '[Server thread/INFO]: Starting\n');
        await appendFile(latest, '[Server thread/INFO]: Stopping server\n');
        await handle.stopped;
        assert.strictEqual(handle.sawStopping(), true);
        assert.deepStrictEqual(exits, [], 'no exit before Done');
        await appendFile(latest, DONE);
        const line = await pending;
        assert.match(line, /Done \(2\.5s\)!/);
        assert.doesNotMatch(line, /146\.414s/);
        assert.deepStrictEqual(exits, [EXIT_BACKEND_READY]);
        assert.strictEqual(EXIT_BACKEND_READY, 75);
        assert.strictEqual(latch.resumed, true);
        assert.strictEqual(latch.latched, false);
        assert.match(logs[0], /backend ready: .*Done \(2\.5s\)!/);
        await rm(dir, { recursive: true, force: true });
    });

    it('Stopping server after arm is backend-stopping and waits; without it the disconnect exits 1', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix94-stop-'));
        const latest = path.join(dir, 'latest.log');
        await writeFile(latest, START + 'server up\n');
        const quiet = armBackendReady({ logDir: dir });
        const plain = { latched: false };
        const plainExits = [];
        applyDisconnect(plain, 'end', 'socketClosed', (code) => plainExits.push(code));
        assert.strictEqual(quiet.sawStopping(), false);
        assert.strictEqual(plain.kind, 'disconnect');
        assert.deepStrictEqual(plainExits, [1]);
        quiet.close();

        const handle = armBackendReady({ logDir: dir });
        await appendFile(latest, '[03:47:12] [Server thread/INFO]: Stopping server\n');
        await handle.stopped;
        assert.strictEqual(handle.sawStopping(), true);
        const latch = { latched: false };
        const outcome = latchBackendStopping(latch, 'kicked', 'NativeIoException: Connection reset by peer');
        assert.strictEqual(outcome.kind, 'backend-stopping');
        const exits = [];
        const pending = resumeWhenBackendReady({
            logDir: dir,
            latch,
            watch: handle,
            exitFn: (code) => exits.push(code),
            log: () => {},
        });
        assert.deepStrictEqual(exits, [], 'no exit before Done');
        await appendFile(latest, DONE);
        await pending;
        assert.deepStrictEqual(exits, [75]);
        assert.strictEqual(latch.resumed, true);
        await rm(dir, { recursive: true, force: true });
    });

    it('a new latest.log without Done does not resolve, and a watcher read error rejects', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix94-rot-'));
        const latest = path.join(dir, 'latest.log');
        await writeFile(latest, START + 'boot\n');
        const handle = armBackendReady({ logDir: dir });
        let settled = false;
        handle.ready.then(() => { settled = true; }, () => { settled = true; });
        await rename(latest, path.join(dir, 'old.log'));
        await writeFile(latest, '[Server thread/INFO]: Preparing spawn area\n');
        await appendFile(latest, '[Server thread/INFO]: Stopping server\n');
        await handle.stopped;
        await Promise.resolve();
        assert.strictEqual(settled, false);
        handle.close();

        const dir2 = await mkdtemp(path.join(tmpdir(), 'fix94-err-'));
        const log2 = path.join(dir2, 'latest.log');
        await writeFile(log2, START + 'up\n');
        const broken = armBackendReady({ logDir: dir2 });
        const failed = broken.ready.then(() => { throw new Error('watch resolved'); }, (err) => err);
        await rm(log2);
        await mkdir(log2);
        await writeFile(path.join(dir2, 'touch.txt'), 'x');
        const watchErr = await failed;
        assert.strictEqual(watchErr && watchErr.code, 'EISDIR');
        await rm(dir, { recursive: true, force: true });
        await rm(dir2, { recursive: true, force: true });
    });

    it('missing backend_log_dir throws, and a directory without latest.log throws', async () => {
        assert.throws(() => requireBackendLogDir({}), /backend_log_dir is required/);
        assert.throws(() => requireBackendLogDir({ backend_log_dir: '' }), /no backend readiness source configured/);
        const dir = await mkdtemp(path.join(tmpdir(), 'fix94-miss-'));
        assert.throws(() => requireBackendLogDir({ backend_log_dir: dir }), /no latest.log/);
        await writeFile(path.join(dir, 'latest.log'), '');
        assert.strictEqual(requireBackendLogDir({ backend_log_dir: dir }), dir);
        assert.strictEqual(existsSync(path.join(dir, 'latest.log')), true);
        await rm(dir, { recursive: true, force: true });
    });

    it('the refusal is transport evidence on any host:port, and 75 restarts exactly once under the live policy', () => {
        const src = readFileSync(new URL('../src/process/backend_unavailable.js', import.meta.url), 'utf8');
        assert.doesNotMatch(src, /127\.0\.0\.1:25565/);
        const other = 'AnnotatedConnectException finishConnect(..) failed with error(-61): Connection refused: /10.1.2.3:25565';
        assert.strictEqual(classifyBackendRefusal('kicked', other).kind, 'backend-unavailable');
        const proxy = 'AnnotatedConnectException finishConnect(..) failed with error(-61): Connection refused: /192.168.9.9:25568';
        assert.strictEqual(classifyBackendRefusal('kicked', proxy).kind, 'backend-unavailable');
        assert.strictEqual(classifyBackendRefusal('kicked', 'Connection refused: /127.0.0.1:25565'), null);
        assert.strictEqual(configuredLink({ host: '127.0.0.1', port: 25568 }), '127.0.0.1:25568');
        assert.strictEqual(configuredLink({ host: '127.0.0.1', port: '25568' }), '127.0.0.1:25568');
        assert.throws(() => configuredLink({ host: '127.0.0.1' }), /settings.port required/);
        const decided = parentExitForChild(75, null);
        assert.deepStrictEqual(decided, { code: 75, kind: 'backend-ready' });
        assert.strictEqual(launchdWouldRestart(decided.code, POLICY), true);
        assert.strictEqual(launchdWouldRestart(0, POLICY), false);
        const settingsSrc = readFileSync(new URL('../settings.js', import.meta.url), 'utf8');
        assert.match(settingsSrc, /\/Users\/mohammedterry-jack\/MinecraftServer\/logs/);
        const launcher = readFileSync(new URL('../run-native.sh', import.meta.url), 'utf8');
        assert.doesNotMatch(launcher, /BACKEND_LOG_DIR:-/);
        assert.doesNotMatch(launcher, /\$\{BACKEND_LOG_DIR:-/);
    });
});

describe('fix94 current run already Done', () => {
    it('a latest.log with no Starting minecraft server line is the current run from offset 0', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix94-nostart-'));
        await writeFile(path.join(dir, 'latest.log'), OLD_DONE);
        const handle = armBackendReady({ logDir: dir });
        const line = await handle.ready;
        assert.match(line, /Done \(146\.414s\)!/);
        await rm(dir, { recursive: true, force: true });
    });

    it('Done already present before arming resolves immediately on the exit 75 path', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix94-already-'));
        const latest = path.join(dir, 'latest.log');
        await writeFile(latest, START + '[12:04:02] [Server thread/INFO]: Done (1.2s)!\n');
        const latch = { latched: true, kind: 'backend-unavailable', evidence: 'refused' };
        const exits = [];
        const logs = [];
        const line = await resumeWhenBackendReady({
            logDir: dir,
            latch,
            exitFn: (code) => exits.push(code),
            log: (msg) => logs.push(msg),
        });
        assert.match(line, /Done \(1\.2s\)!/);
        assert.deepStrictEqual(exits, [EXIT_BACKEND_READY]);
        assert.strictEqual(EXIT_BACKEND_READY, 75);
        assert.strictEqual(latch.resumed, true);
        assert.match(logs[0], /backend ready: .*Done \(1\.2s\)!/);
        await rm(dir, { recursive: true, force: true });
    });

    it('Done from a previous run followed by Stopping server does not resolve', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix94-prev-'));
        const latest = path.join(dir, 'latest.log');
        await writeFile(latest, START + OLD_DONE + '[12:05:40] [Server thread/INFO]: Stopping server\n');
        const handle = armBackendReady({ logDir: dir });
        let settled = false;
        handle.ready.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        assert.strictEqual(settled, false);
        assert.strictEqual(handle.sawStopping(), true);
        await appendFile(latest, '[12:06:00] [Server thread/INFO]: Starting minecraft server version 1.21.4\n');
        await appendFile(latest, '[12:06:00] [Server thread/INFO]: Preparing spawn area: 0%\n');
        handle.readNew();
        await Promise.resolve();
        assert.strictEqual(settled, false, 'the new run has not logged Done');
        handle.close();
        await rm(dir, { recursive: true, force: true });
    });

    it('Done written after arm still resolves', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix94-after-'));
        const latest = path.join(dir, 'latest.log');
        await writeFile(latest, START + '[12:04:01] [Server thread/INFO]: Preparing spawn area: 20%\n');
        const latch = { latched: true, kind: 'backend-unavailable', evidence: 'refused' };
        const handle = armBackendReady({ logDir: dir });
        let settled = false;
        handle.ready.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        assert.strictEqual(settled, false);
        const exits = [];
        const pending = resumeWhenBackendReady({
            logDir: dir,
            latch,
            watch: handle,
            exitFn: (code) => exits.push(code),
            log: () => {},
        });
        await appendFile(latest, DONE);
        const line = await pending;
        assert.match(line, /Done \(2\.5s\)!/);
        assert.deepStrictEqual(exits, [75]);
        assert.strictEqual(latch.resumed, true);
        await rm(dir, { recursive: true, force: true });
    });
});

// fix96: the fix94 cut (keep a prefix, drop the tail, sized by a guessed chars-per-token) is gone. Mo: no prompt text is
// ever cut. The whole prompt is sent with Ollama's own silent cuts off (truncate:false, shift:false); a prompt that does
// not fit is Ollama's 400 with its real token count, thrown loudly, and nothing is learned from it to cut the next one.
describe('fix96 ollama context: never cut', () => {
    it('the 400 is parsed, and the overflow error names each message size', () => {
        const overflow = parseContextOverflow('Ollama 400: {"error":"request (8243 tokens) exceeds the available context size (8192 tokens), try increasing it"}');
        assert.deepStrictEqual(overflow, { requestTokens: 8243, contextTokens: 8192 });
        assert.strictEqual(chatSectionSizes([{ role: 'system', content: 'abc' }, { role: 'user', content: 'hello' }]), 'system=3,user=5');
        assert.throws(() => chatSectionSizes([]), /messages required/);
        assert.deepStrictEqual({ ...NEVER_CUT_PROMPT }, { truncate: false, shift: false });
    });

    it('send passes the whole prompt with truncate:false and shift:false, and asks /api/show nothing', async () => {
        const seen = [];
        const server = await listen((req, res) => {
            let raw = '';
            req.on('data', (chunk) => { raw += chunk; });
            req.on('end', () => {
                seen.push({ url: req.url, body: JSON.parse(raw) });
                res.end(chatReply('{"reasoning":"fit","task":"Mine 1 oak_log","context":"whole"}'));
            });
        });
        try {
            setCallDurationStore({ 'qwen3 /api/chat': { n: 1, cpt: 2.67 } });   // a learned density is not used to cut
            const ollama = new Ollama('qwen3', `http://127.0.0.1:${server.address().port}`, { keep_alive: -1, options: { num_ctx: 48, num_predict: 8 } });
            const user = 'u'.repeat(48 * 40);
            const reply = await ollama.sendRequest([{ role: 'user', content: user }], 'system prose');
            assert.strictEqual(reply, '{"reasoning":"fit","task":"Mine 1 oak_log","context":"whole"}');
            assert.deepStrictEqual(seen.map((call) => call.url), ['/api/chat']);
            const body = seen[0].body;
            assert.strictEqual(body.truncate, false);
            assert.strictEqual(body.shift, false);
            assert.strictEqual(body.messages[0].content, 'system prose');
            assert.strictEqual(body.messages[1].content, user, 'the user message reached Ollama whole');
        } finally {
            server.close();
            setCallDurationStore({});
        }
    });

    it('a prompt over the context throws loudly every time; nothing is learned and nothing is cut', async () => {
        const seen = [];
        const server = await listen((req, res) => {
            let raw = '';
            req.on('data', (chunk) => { raw += chunk; });
            req.on('end', () => {
                seen.push(JSON.parse(raw || '{}'));
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'request (8243 tokens) exceeds the available context size (8192 tokens), try increasing it' }));
            });
        });
        try {
            const store = {};
            setCallDurationStore(store);
            const ollama = new Ollama('qwen3', `http://127.0.0.1:${server.address().port}`, { keep_alive: -1, options: { num_ctx: 100 } });
            const user = 'y'.repeat(500);
            for (let i = 0; i < 2; i++) {
                await assert.rejects(
                    () => ollama.sendRequest([{ role: 'user', content: user }], 'system-instructions'),
                    (err) => {
                        assert.match(err.message, /prompt does not fit: 8243 tokens, context 8192 tokens/);
                        assert.match(err.message, /nothing was cut/);
                        assert.match(err.message, /system=19,user=500/);
                        return true;
                    },
                );
            }
            assert.strictEqual(seen.length, 2);
            for (const body of seen) assert.strictEqual(body.messages[1].content, user);
            assert.deepStrictEqual(store, {}, 'no density learned from the 400');
            const src = readFileSync(new URL('../src/models/ollama.js', import.meta.url), 'utf8');
            assert.doesNotMatch(src, /fitChatToBudget|_fitToBudget|estimateTokens|learnedCharsPerToken|notePromptDensity|\/api\/show/);
            assert.doesNotMatch(src, /My brain disconnected/);
        } finally {
            server.close();
            setCallDurationStore({});
        }
    });
});
