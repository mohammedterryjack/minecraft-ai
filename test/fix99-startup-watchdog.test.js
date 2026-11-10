// fix99: a rolled latest.log is the current run from offset 0, and the watchdog limit
// is the vanilla keep-alive kick bound. A keep_alive gap is not a sample.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, appendFile, rename, rm, open, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { armBackendReady, offsetOfCurrentRun } from '../src/process/backend_ready.js';
import { resumeWhenBackendReady, EXIT_BACKEND_READY } from '../src/process/backend_unavailable.js';
import {
    startEventLoopStallGuard, stopEventLoopStallGuard, stallThresholdMs, watchdogSilenceLimitMs,
    watchdogBeatPeriodMs, KEEP_ALIVE_INTERVAL_MS, KEEP_ALIVE_KICK_MS, GAME_TICK_MS,
} from '../src/utils/event_loop_guard.js';

const START = '[12:04:00] [Server thread/INFO]: Starting minecraft server version 1.21.4\n';
const DONE = '[00:02:04] [Server thread/INFO]: Done (2.5s)!\n';
const SHORT_GAP_MS = 3133;
const CHILD = fileURLToPath(new URL('./fixtures/fix99-idle-watchdog-child.mjs', import.meta.url));
const SILENCE_CHILD = fileURLToPath(new URL('./fixtures/fix99-silence-watchdog-child.mjs', import.meta.url));

describe('fix99: a rolled latest.log is the current run from offset 0', () => {
    it('a log with no start line has offset 0', () => {
        assert.strictEqual(offsetOfCurrentRun(Buffer.from('[00:02:01] [Server thread/INFO]: Preparing spawn area: 100%\n' + DONE)), 0);
        const withStart = Buffer.from('old\n' + START + 'preparing\n');
        assert.ok(offsetOfCurrentRun(withStart) > 0);
    });

    it('a rolled latest.log with no start line resolves Done and does not read the gzip', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix99-roll-'));
        const latest = path.join(dir, 'latest.log');
        await writeFile(path.join(dir, '2026-11-09-4.log.gz'), Buffer.from([0x1f, 0x8b, 0xff, 0x00]));
        await writeFile(latest, '[00:02:01] [Server thread/INFO]: Preparing spawn area: 100%\n' + DONE);
        const handle = armBackendReady({ logDir: dir });
        const line = await handle.ready;
        assert.match(line, /Done \(2\.5s\)!/);
        await rm(dir, { recursive: true, force: true });
    });

    it('a server that is still starting stays pending until Done', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix99-starting-'));
        const latest = path.join(dir, 'latest.log');
        await writeFile(latest, START + '[00:02:01] [Server thread/INFO]: Preparing spawn area: 40%\n');
        const handle = armBackendReady({ logDir: dir });
        let settled = false;
        handle.ready.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        assert.strictEqual(settled, false);
        await appendFile(latest, DONE);
        handle.readNew();
        const line = await handle.ready;
        assert.match(line, /Done \(2\.5s\)!/);
        await rm(dir, { recursive: true, force: true });
    });

    it('a refusal before login, with a rotated log, waits for Done and exits 75', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix99-prelogin-'));
        const latest = path.join(dir, 'latest.log');
        await writeFile(path.join(dir, '2026-11-09-4.log.gz'), START);
        await writeFile(latest, '[00:02:01] [Server thread/INFO]: Preparing spawn area: 40%\n');
        const latch = { latched: true, kind: 'backend-unavailable', evidence: 'Connection refused' };
        const exits = [];
        const pending = resumeWhenBackendReady({
            logDir: dir,
            latch,
            watch: null,
            exitFn: (code) => exits.push(code),
            log: () => {},
        });
        await Promise.resolve();
        assert.deepStrictEqual(exits, []);
        await appendFile(latest, DONE);
        const line = await pending;
        assert.match(line, /Done \(2\.5s\)!/);
        assert.deepStrictEqual(exits, [EXIT_BACKEND_READY]);
        assert.strictEqual(EXIT_BACKEND_READY, 75);
        assert.strictEqual(latch.resumed, true);
        await rm(dir, { recursive: true, force: true });
    });

    it('a new inode resets the offset to 0', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix99-inode-'));
        const latest = path.join(dir, 'latest.log');
        await writeFile(latest, START + '[12:04:01] [Server thread/INFO]: Preparing spawn area: 20%\n');
        const before = await stat(latest);
        const handle = armBackendReady({ logDir: dir });
        let settled = false;
        handle.ready.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        assert.strictEqual(settled, false);
        await rename(latest, path.join(dir, 'rolled.log'));
        await writeFile(latest, DONE);
        const after = await stat(latest);
        assert.notStrictEqual(after.ino, before.ino);
        handle.readNew();
        const line = await handle.ready;
        assert.match(line, /Done \(2\.5s\)!/);
        await rm(dir, { recursive: true, force: true });
    });

    it('a shrunk file resets the offset to 0', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix99-shrink-'));
        const latest = path.join(dir, 'latest.log');
        const prefix = `${'z'.repeat(4000)}\n`;
        await writeFile(latest, prefix + START + '[12:04:01] [Server thread/INFO]: Preparing spawn area: 20%\n');
        const before = await stat(latest);
        const off = offsetOfCurrentRun(readFileSync(latest));
        assert.ok(off > Buffer.byteLength(DONE));
        const handle = armBackendReady({ logDir: dir });
        let settled = false;
        handle.ready.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        assert.strictEqual(settled, false);
        const fh = await open(latest, 'r+');
        await fh.truncate(0);
        await fh.write(DONE, 0);
        await fh.close();
        const after = await stat(latest);
        assert.strictEqual(after.ino, before.ino);
        assert.ok(after.size < off);
        handle.readNew();
        const line = await handle.ready;
        assert.match(line, /Done \(2\.5s\)!/);
        await rm(dir, { recursive: true, force: true });
    });
});

describe('fix99: the watchdog limit is the keep-alive kick bound', () => {
    it('a 3133ms gap leaves the limit at 15000×2', () => {
        const realNow = Date.now;
        let now = 1_000_000;
        Date.now = () => now;
        const bot = { _client: new EventEmitter() };
        try {
            startEventLoopStallGuard(bot);
            bot._client.emit('keep_alive');
            for (const gap of [KEEP_ALIVE_INTERVAL_MS * 2, KEEP_ALIVE_KICK_MS, SHORT_GAP_MS]) {
                now += gap;
                bot._client.emit('keep_alive');
            }
            // The gap does not move the watchdog. The STALL log is one game tick, not this kick bound.
            assert.strictEqual(stallThresholdMs(bot), GAME_TICK_MS);
            assert.notStrictEqual(stallThresholdMs(bot), KEEP_ALIVE_KICK_MS);
            assert.strictEqual(watchdogSilenceLimitMs(), KEEP_ALIVE_KICK_MS);
            assert.strictEqual(KEEP_ALIVE_KICK_MS, KEEP_ALIVE_INTERVAL_MS * 2);
            assert.strictEqual(watchdogBeatPeriodMs(), Math.floor(KEEP_ALIVE_INTERVAL_MS / 2));
            assert.ok(watchdogSilenceLimitMs() > SHORT_GAP_MS + Math.floor(SHORT_GAP_MS / 2));
        } finally {
            stopEventLoopStallGuard(bot);
            Date.now = realNow;
        }
    });

    it('the 06:40 idle hold, with a 3133ms gap and no phase and no bot API call, is not SIGKILLed', { timeout: KEEP_ALIVE_INTERVAL_MS }, async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix99-idle-'));
        const ev = path.join(dir, 'watchdog_kill.json');
        const child = spawn(process.execPath, [CHILD, ev], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        const ended = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
        assert.strictEqual(ended.signal, null, stderr);
        assert.strictEqual(ended.code, 0, stderr);
        assert.strictEqual(existsSync(ev), false, stderr);
        assert.doesNotMatch(stderr, /MAIN THREAD BLOCKED/);
        await rm(dir, { recursive: true, force: true });
    });

    it('a real 31s silence arms the kill', { timeout: KEEP_ALIVE_KICK_MS + watchdogBeatPeriodMs() }, async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix99-silence-'));
        const ev = path.join(dir, 'watchdog_kill.json');
        const child = spawn(process.execPath, [SILENCE_CHILD, ev], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        const ended = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
        assert.strictEqual(ended.signal, 'SIGKILL', stderr);
        assert.match(stderr, /MAIN THREAD BLOCKED/);
        assert.match(stderr, /limit 30000ms/);
        assert.strictEqual(existsSync(ev), true);
        await rm(dir, { recursive: true, force: true });
    });
});
