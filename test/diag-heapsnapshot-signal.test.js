// diag: the agent child argv carries --heapsnapshot-signal=SIGUSR2 and
// --diagnostic-dir=<project logs>/heap, and that directory exists before spawn.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentChildArgv, HEAP_SNAPSHOT_DIR } from '../src/process/agent_process.js';

const INIT_AGENT = fileURLToPath(new URL('../src/process/init_agent.js', import.meta.url));
const PROJECT_LOGS = fileURLToPath(new URL('../logs/', import.meta.url));

describe('diag: heap snapshot on SIGUSR2 for the agent child', () => {
    it('agentChildArgv includes both flags and creates logs/heap', () => {
        rmSync(HEAP_SNAPSHOT_DIR, { recursive: true, force: true });
        try {
            assert.strictEqual(existsSync(HEAP_SNAPSHOT_DIR), false);

            const args = agentChildArgv('icefox2000', 8080, false, null, 0);

            assert.strictEqual(HEAP_SNAPSHOT_DIR, path.join(PROJECT_LOGS, 'heap'));
            assert.strictEqual(statSync(HEAP_SNAPSHOT_DIR).isDirectory(), true);
            assert.deepStrictEqual(args, [
                '--heapsnapshot-signal=SIGUSR2',
                `--diagnostic-dir=${HEAP_SNAPSHOT_DIR}`,
                INIT_AGENT,
                'icefox2000',
                '-n', 'icefox2000',
                '-c', 0,
                '-p', 8080,
            ]);
            assert.ok(!args.some((arg) => String(arg).includes('max-old-space-size')));

            const withMemory = agentChildArgv('icefox2000', 8080, true, 'Agent process restarted.', 3);
            assert.deepStrictEqual(withMemory, [
                '--heapsnapshot-signal=SIGUSR2',
                `--diagnostic-dir=${HEAP_SNAPSHOT_DIR}`,
                INIT_AGENT,
                'icefox2000',
                '-n', 'icefox2000',
                '-c', 3,
                '-l', true,
                '-m', 'Agent process restarted.',
                '-p', 8080,
            ]);

            const child = spawnSync(process.execPath, [
                ...args.slice(0, 2),
                '-e',
                'process.stdout.write(process.execArgv.join("\\n"))',
            ], { encoding: 'utf8', timeout: 15000 });
            if (child.error) throw child.error;
            assert.strictEqual(child.status, 0, child.stderr);
            const execArgv = child.stdout.split('\n');
            assert.ok(execArgv.includes('--heapsnapshot-signal=SIGUSR2'));
            assert.ok(execArgv.includes(`--diagnostic-dir=${HEAP_SNAPSHOT_DIR}`));
        } finally {
            rmSync(HEAP_SNAPSHOT_DIR, { recursive: true, force: true });
        }
    });
});
