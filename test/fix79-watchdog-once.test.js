// fix79: the watchdog worker kills once and stops. Before, the loop went round again after process.kill(pid, 'SIGKILL'): a
// self-kill does not stop the worker thread at once (macOS), so it re-logged and re-wrote (truncated) the evidence file while
// the process was torn down. iMac, 40 runs of the fix64 child: 5 runs logged 2-3 "MAIN THREAD BLOCKED" lines, 2 left an empty
// watchdog_kill.json -> the flaky fix65 end-to-end test ("Unexpected end of JSON input").
// Here the worker watches ANOTHER process, so the kill does not end the worker and the old loop is deterministic: it
// re-wrote the file and then threw ESRCH on the second kill of a dead pid.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { Worker, MessageChannel } from 'node:worker_threads';
import { existsSync, readFileSync, rmSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { CALL_SLOT_BYTES } from '../src/utils/main_thread_watchdog.js';

const WORKER = fileURLToPath(new URL('../src/utils/main_thread_watchdog_worker.mjs', import.meta.url));
const LIMIT_MS = 50;

describe('fix79: watchdog worker writes its evidence once, complete, then parks', () => {
    it('one kill, one complete evidence file, no second write, no worker error', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fix79-wd-'));
        const ev = join(dir, 'watchdog_kill.json');
        const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
        const ctl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
        const { port1, port2 } = new MessageChannel();
        const callLenSab = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT), callSab = new SharedArrayBuffer(CALL_SLOT_BYTES);   // fix96
        const worker = new Worker(WORKER, { workerData: { sab: ctl.buffer, callLenSab, callSab, port: port2, pid: victim.pid, evidencePath: ev }, transferList: [port2], stderr: true });
        const errors = []; worker.on('error', e => errors.push(e));
        port1.postMessage({ phases: ['test'], skill: 'spin', stack: 'a <- b' });
        Atomics.store(ctl, 1, LIMIT_MS); Atomics.notify(ctl, 1);   // armed; no beats ever follow
        const signal = await new Promise(r => victim.on('exit', (c, s) => r(s)));
        assert.strictEqual(signal, 'SIGKILL');
        const first = JSON.parse(readFileSync(ev, 'utf8'));
        assert.strictEqual(first.pid, victim.pid);
        assert.strictEqual(first.stack, 'a <- b');
        rmSync(ev);
        // the old loop re-wrote within one limit period; give it ten
        await new Promise(r => setTimeout(r, 10 * LIMIT_MS));
        assert.strictEqual(existsSync(ev), false, 'evidence was written again after the kill');
        assert.deepStrictEqual(errors, [], 'the worker went round its loop again (second kill of a dead pid)');
        assert.deepStrictEqual(readdirSync(dir), [], 'no temp file left behind');
        await worker.terminate();
        port1.close();
        rmSync(dir, { recursive: true, force: true });
    });
});
