/**
 * fix103: an uncaughtException or unhandledRejection while a step is running is fatal.
 * It is not pushed onto progress.failed and it is not learned.
 * The wedge child installs the same process handlers as voyager.js and fatalExit from fatal.js.
 * The throw is inside the deserializer push. Fixed code exits 1 before the next keep_alive.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Voyager } from '../src/agent/voyager.js';

const WEDGE = fileURLToPath(new URL('./fixtures/fix103-wedge-child.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

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

    it('a block_change throw is fatal and no later keep_alive is delivered', async () => {
        const child = spawn(process.execPath, [WEDGE, ROOT], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (buf) => { stdout += buf; });
        child.stderr.on('data', (buf) => { stderr += buf; });
        const ended = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
        assert.strictEqual(ended, 1, `${stderr}\n${stdout}`);
        assert.match(stderr, /\[fatal\] UNCAUGHT EXCEPTION/);
        assert.doesNotMatch(stdout, /SAVED/);
        assert.doesNotMatch(stdout, /"alive":true/);
        const snap = JSON.parse(stdout.trim().split('\n')[0]);
        assert.deepStrictEqual(snap.failed, []);
        assert.deepStrictEqual(snap.delivered, ['keep_alive 1', 'block_change']);
        assert.ok(!snap.delivered.some((line) => line.startsWith('keep_alive ') && line !== 'keep_alive 1'));
    });
});
