// Cursor subscription via the official Cursor CLI in headless print mode
// (https://cursor.com/docs/cli/headless). Auth: CURSOR_API_KEY env (from the gitignored .env).
// Runs in an empty working dir with --mode ask (read-only, no file edits / shell).
import { execFile } from 'child_process';
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
    async sendRequest(turns, systemMessage) {
        const convo = turns.map(t => `${t.role.toUpperCase()}:\n${t.content}`).join('\n\n');
        const prompt = `${systemMessage}\n\n${convo}\n\nRespond directly with the answer text only. Do not use any tools.`;
        const args = ['-p', '--trust', '--mode', 'ask', '--output-format', 'json', '--model', this.model_name, prompt];
        const t0 = Date.now();
        return await new Promise((resolve, reject) => {
            execFile(BIN, args, { cwd: WORKDIR, timeout: this.timeoutMs, maxBuffer: 32 * 1024 * 1024, env: process.env },
                (err, stdout, stderr) => {
                    const ms = Date.now() - t0;
                    let obj = null;
                    try { obj = JSON.parse(String(stdout).trim().split('\n').pop()); } catch {}
                    if (!err && obj && !obj.is_error && typeof obj.result === 'string') {
                        console.log(`[cursor] ${this.model_name} ok in ${ms}ms (api ${obj.duration_api_ms}ms)`);
                        return resolve(obj.result);
                    }
                    const msg = String(stderr || '').trim().slice(0, 400) || String(err?.message || 'no output').slice(0, 400);
                    const e = new Error(`cursor-agent failed after ${ms}ms: ${msg}`);
                    if (LIMIT_RE.test(msg)) { e.status = 429; e.message = 'cursor usage limit / quota: ' + msg; }
                    reject(e);
                });
        });
    }
}
