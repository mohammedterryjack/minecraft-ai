/**
 * fix103: an uncaughtException or unhandledRejection while a step is running is fatal.
 * It is not pushed onto progress.failed and it is not learned.
 * The wedge child shows why resuming is unsafe: the throw is inside the deserializer push,
 * cb() never runs, and the next keep_alive is not delivered.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Voyager } from '../src/agent/voyager.js';

const WEDGE = fileURLToPath(new URL('./fixtures/fix103-wedge-child.cjs', import.meta.url));

function runningStep() {
    const failed = [];
    const fatals = [];
    const v = Object.create(Voyager.prototype);
    v.running = true;
    v.currentTask = 'reach iron_ore';
    v.progress = { failed };
    v._saveProgress = () => { throw new Error('process error must not save progress'); };
    v.agent = {
        fatal: (why, err) => { fatals.push({ why, err }); },
        requestInterrupt: () => { throw new Error('process error must not interrupt the step'); },
        actions: { stop: () => { throw new Error('process error must not stop the step'); } },
    };
    return { v, failed, fatals };
}

describe('fix103 process errors are fatal', () => {
    it('uncaughtException during a step calls fatal and does not record the step', () => {
        const { v, failed, fatals } = runningStep();
        const err = new Error('nearby blocks: chunk 6,6 is loaded in the view and is neither indexed nor pending.');
        v._onProcessError('UNCAUGHT EXCEPTION', err);
        assert.strictEqual(fatals.length, 1);
        assert.strictEqual(fatals[0].why, 'UNCAUGHT EXCEPTION');
        assert.strictEqual(fatals[0].err, err);
        assert.deepStrictEqual(failed, []);
        assert.strictEqual(v._crash, undefined);
    });

    it('unhandledRejection during a step calls fatal and does not record the step', () => {
        const { v, failed, fatals } = runningStep();
        const err = new Error('rejected while reach iron_ore was running');
        v._onProcessError('UNHANDLED REJECTION', err);
        assert.strictEqual(fatals.length, 1);
        assert.strictEqual(fatals[0].why, 'UNHANDLED REJECTION');
        assert.strictEqual(fatals[0].err, err);
        assert.deepStrictEqual(failed, []);
        assert.strictEqual(v._crash, undefined);
    });

    it('a swallowed throw inside the deserializer push wedges the packet pipeline', async () => {
        const child = spawn(process.execPath, [WEDGE], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (buf) => { stdout += buf; });
        child.stderr.on('data', (buf) => { stderr += buf; });
        const ended = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
        assert.strictEqual(ended, 0, `${stderr}\n${stdout}`);
        const report = JSON.parse(stdout);
        assert.deepStrictEqual(report.delivered, ['keep_alive 1', 'block_change']);
        assert.strictEqual(report.swallowed, 1);
        assert.strictEqual(report.deserializerWriting, true);
        assert.strictEqual(report.splitterWriting, true);
        assert.strictEqual(report.wedged, true);
        assert.match(stderr, /nearby blocks: chunk 6,6/);
    });
});
