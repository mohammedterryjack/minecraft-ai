// Cursor subscription via the official Cursor CLI in headless print mode
// (https://cursor.com/docs/cli/headless). Auth: CURSOR_API_KEY env (from the gitignored .env).
// Runs in an empty working dir with --mode ask (read-only, no file edits / shell).
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

const BIN = process.env.CURSOR_AGENT_BIN || path.join(os.homedir(), '.local/bin/cursor-agent');
const WORKDIR = path.join(os.tmpdir(), 'cursor-empty');
const LIMIT_RE = /usage limit|limit reached|out of (credits|usage)|exceeded|quota|rate.?limit|upgrade your plan|spending limit|\b429\b/i;

export class CursorCLI {
    static prefix = 'cursor';
    constructor(model_name, url, params) {
        this.model_name = model_name || 'composer-2.5';
        this.params = params || {};
        this.timeoutMs = (this.params.timeout_s || 170) * 1000;
        mkdirSync(WORKDIR, { recursive: true });
    }
    // fix31: the CLI takes ~3s to start; keep one process started ahead of time, waiting for its prompt on stdin
    _spawn() {
        const args = ['-p', '--trust', '--mode', 'ask', '--output-format', 'json', '--model', this.model_name];
        const p = spawn(BIN, args, { cwd: WORKDIR, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
        const r = { p, out: '', err: '', exited: false, code: null };
        p.stdout.on('data', d => { r.out += d; }); p.stderr.on('data', d => { r.err += d; });
        r.done = new Promise(res => p.on('close', code => { r.exited = true; r.code = code; res(); }));
        p.on('error', e => { r.err += String(e.message); });
        return r;
    }
    _take() { const w = this._warm; this._warm = null; if (w && !w.exited) return { w, warm: true }; return { w: this._spawn(), warm: false }; }
    async sendRequest(turns, systemMessage) {
        const convo = turns.map(t => `${t.role.toUpperCase()}:\n${t.content}`).join('\n\n');
        const prompt = `${systemMessage}\n\n${convo}\n\nRespond directly with the answer text only. Do not use any tools.`;
        const t0 = Date.now(), { w, warm } = this._take();
        w.p.stdin.end(prompt);
        let timer; const to = new Promise(res => { timer = setTimeout(() => { try { w.p.kill('SIGKILL'); } catch {} res('timeout'); }, this.timeoutMs); });
        const how = await Promise.race([w.done.then(() => 'done'), to]); clearTimeout(timer);
        this._warm = this._spawn();
        const ms = Date.now() - t0;
        let obj = null; try { obj = JSON.parse(String(w.out).trim().split('\n').pop()); } catch {}
        if (how === 'done' && w.code === 0 && obj && !obj.is_error && typeof obj.result === 'string') {
            console.log(`[cursor] ${this.model_name} ok in ${ms}ms (api ${obj.duration_api_ms}ms, ${warm ? 'pre-started' : 'cold'} process)`);
            return obj.result;
        }
        const msg = how === 'timeout' ? `timeout after ${this.timeoutMs / 1000}s` : (String(w.err).trim().slice(0, 400) || `exit ${w.code}, no output`);
        const e = new Error(`cursor-agent failed after ${ms}ms: ${msg}`);
        if (LIMIT_RE.test(msg)) { e.status = 429; e.message = 'cursor usage limit / quota: ' + msg; }
        throw e;
    }
}
