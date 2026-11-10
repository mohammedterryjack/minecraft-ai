// diag: the agent child argv carries --heapsnapshot-signal=SIGUSR2 and
// --diagnostic-dir for the directory the caller passes. Production passes
// logs/heap. This test uses a temp directory and does not touch logs/.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentChildArgv, HEAP_SNAPSHOT_DIR } from '../src/process/agent_process.js';

const INIT_AGENT = fileURLToPath(new URL('../src/process/init_agent.js', import.meta.url));
const PROJECT_LOGS = fileURLToPath(new URL('../logs/', import.meta.url));
const AGENT_PROCESS_SRC = fileURLToPath(new URL('../src/process/agent_process.js', import.meta.url));

describe('diag: heap snapshot on SIGUSR2 for the agent child', () => {
    it('agentChildArgv includes both flags and creates the diagnostic dir it is given', () => {
        const realExisted = existsSync(HEAP_SNAPSHOT_DIR);
        const parent = mkdtempSync(path.join(tmpdir(), 'diag-heap-'));
        const diagnosticDir = path.join(parent, 'heap');
        try {
            assert.strictEqual(existsSync(diagnosticDir), false);
            assert.strictEqual(HEAP_SNAPSHOT_DIR, path.join(PROJECT_LOGS, 'heap'));
            assert.ok(!diagnosticDir.startsWith(PROJECT_LOGS));

            const args = agentChildArgv('icefox2000', 8080, false, null, 0, diagnosticDir);

            assert.strictEqual(statSync(diagnosticDir).isDirectory(), true);
            assert.strictEqual(existsSync(HEAP_SNAPSHOT_DIR), realExisted);
            assert.deepStrictEqual(args, [
                '--heapsnapshot-signal=SIGUSR2',
                `--diagnostic-dir=${diagnosticDir}`,
                INIT_AGENT,
                'icefox2000',
                '-n', 'icefox2000',
                '-c', 0,
                '-p', 8080,
            ]);
            assert.ok(!args.some((arg) => String(arg).includes(HEAP_SNAPSHOT_DIR)));
            assert.ok(!args.some((arg) => String(arg).includes('max-old-space-size')));

            const withMemory = agentChildArgv('icefox2000', 8080, true, 'Agent process restarted.', 3, diagnosticDir);
            assert.deepStrictEqual(withMemory, [
                '--heapsnapshot-signal=SIGUSR2',
                `--diagnostic-dir=${diagnosticDir}`,
                INIT_AGENT,
                'icefox2000',
                '-n', 'icefox2000',
                '-c', 3,
                '-l', true,
                '-m', 'Agent process restarted.',
                '-p', 8080,
            ]);

            const src = readFileSync(AGENT_PROCESS_SRC, 'utf8');
            assert.match(src, /agentChildArgv\(this\.name, this\.port, load_memory, init_message, count_id, HEAP_SNAPSHOT_DIR\)/);

            const child = spawnSync(process.execPath, [
                ...args.slice(0, 2),
                '-e',
                'process.stdout.write(process.execArgv.join("\\n"))',
            ], { encoding: 'utf8', timeout: 15000 });
            if (child.error) throw child.error;
            assert.strictEqual(child.status, 0, child.stderr);
            const execArgv = child.stdout.split('\n');
            assert.ok(execArgv.includes('--heapsnapshot-signal=SIGUSR2'));
            assert.ok(execArgv.includes(`--diagnostic-dir=${diagnosticDir}`));
            assert.strictEqual(existsSync(HEAP_SNAPSHOT_DIR), realExisted);
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });
});
