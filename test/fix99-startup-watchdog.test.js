// fix99: latest.log rolls at midnight while the JVM keeps running, and one short keep_alive
// gap must not shrink the watchdog limit below the protocol interval or the max gap.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import {
    armBackendReady, readLaunchdPrint, queryMinecraftServer, launchdTarget, MINECRAFT_SERVER_JOB, LAUNCHCTL,
} from '../src/process/backend_ready.js';
import {
    startEventLoopStallGuard, stopEventLoopStallGuard, stallThresholdMs, watchdogSilenceLimitMs,
    stallPollIntervalMsForThreshold, KEEP_ALIVE_INTERVAL_MS,
} from '../src/utils/event_loop_guard.js';

const SERVER = { pid: 4242 };
const START = '[12:04:00] [Server thread/INFO]: Starting minecraft server version 1.21.4\n';
const DONE = '[00:02:04] [Server thread/INFO]: Done (2.5s)!\n';
const SHORT_GAP_MS = 3133;
const CHILD = fileURLToPath(new URL('./fixtures/fix99-idle-watchdog-child.mjs', import.meta.url));

function runningPrint(pid) {
    return [
        `gui/501/${MINECRAFT_SERVER_JOB} = {`,
        '\tactive count = 1',
        '\tstate = running',
        `\tpid = ${pid}`,
        '\tproperties = {',
        '\t\tstate = not the job',
        '\t}',
        '}',
        '',
    ].join('\n');
}

describe('fix99: server run is the launchd pid, including after latest.log rolls', () => {
    it('a rolled latest.log with no start line resolves Done for a running server and does not read the gzip', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix99-roll-'));
        const latest = path.join(dir, 'latest.log');
        await writeFile(path.join(dir, '2026-11-09-4.log.gz'), Buffer.from([0x1f, 0x8b, 0xff, 0x00]));
        await writeFile(latest, '[00:02:01] [Server thread/INFO]: Preparing spawn area: 100%\n' + DONE);
        const handle = armBackendReady({ logDir: dir, server: SERVER });
        const line = await handle.ready;
        assert.match(line, /Done \(2\.5s\)!/);
        await rm(dir, { recursive: true, force: true });
    });

    it('a rolled latest.log with no Done stays pending, including when the gzip holds the only start line', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix99-wait-'));
        const latest = path.join(dir, 'latest.log');
        await writeFile(path.join(dir, '2026-11-09-4.log.gz'), START + DONE);
        await writeFile(latest, '[00:02:01] [Server thread/INFO]: Preparing spawn area: 40%\n');
        const handle = armBackendReady({ logDir: dir, server: SERVER });
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

    it('an absent server throws even when latest.log already contains the start line and Done', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'fix99-down-'));
        await writeFile(path.join(dir, 'latest.log'), START + DONE);
        assert.throws(() => armBackendReady({ logDir: dir }), /not running/);
        assert.throws(() => armBackendReady({ logDir: dir, server: {} }), /not running/);
        assert.throws(() => armBackendReady({ logDir: dir, server: { pid: -1 } }), /not running/);
        await rm(dir, { recursive: true, force: true });
    });
});

describe('fix99: launchctl print is the running server', () => {
    it('state running and a pid is the server; a nested state line is not', () => {
        assert.deepStrictEqual(readLaunchdPrint(runningPrint(4242)), { pid: 4242 });
    });

    it('a job that is not running throws, and a missing pid throws', () => {
        const stopped = `gui/501/${MINECRAFT_SERVER_JOB} = {\n\tstate = not running\n}\n`;
        assert.throws(() => readLaunchdPrint(stopped), /not running/);
        const noPid = `gui/501/${MINECRAFT_SERVER_JOB} = {\n\tstate = running\n}\n`;
        assert.throws(() => readLaunchdPrint(noPid), /0 pid lines/);
    });

    it('queryMinecraftServer prints the gui job and returns its pid', () => {
        const uid = process.getuid();
        const target = launchdTarget(uid);
        let seen;
        const server = queryMinecraftServer((cmd, args, opts) => {
            seen = { cmd, args, opts };
            return runningPrint(99);
        });
        assert.deepStrictEqual(seen, { cmd: LAUNCHCTL, args: ['print', target], opts: { encoding: 'utf8' } });
        assert.strictEqual(target, `gui/${uid}/${MINECRAFT_SERVER_JOB}`);
        assert.deepStrictEqual(server, { pid: 99 });
    });

    it('a failed launchctl print throws the command failure', () => {
        assert.throws(() => queryMinecraftServer(() => { throw new Error('No such process'); }), /launchctl print .* failed: No such process/);
        assert.throws(() => queryMinecraftServer(() => Buffer.from('state')), /not text/);
    });
});

describe('fix99: one short keep_alive gap cannot shrink the watchdog limit', () => {
    it('a 3133ms gap after longer ones leaves the limit at the max, above the protocol floor and above 4699ms', () => {
        const realNow = Date.now;
        let now = 1_000_000;
        Date.now = () => now;
        const bot = { _client: new EventEmitter() };
        try {
            startEventLoopStallGuard(bot);
            bot._client.emit('keep_alive');
            const longGap = KEEP_ALIVE_INTERVAL_MS * 2;
            const midGap = KEEP_ALIVE_INTERVAL_MS + Math.floor(KEEP_ALIVE_INTERVAL_MS / 2);
            for (const gap of [longGap, midGap, KEEP_ALIVE_INTERVAL_MS, SHORT_GAP_MS]) {
                now += gap;
                bot._client.emit('keep_alive');
            }
            const collapsed = SHORT_GAP_MS + Math.floor(SHORT_GAP_MS / 2);
            const floor = KEEP_ALIVE_INTERVAL_MS + stallPollIntervalMsForThreshold(KEEP_ALIVE_INTERVAL_MS);
            assert.strictEqual(stallThresholdMs(bot), longGap);
            assert.strictEqual(watchdogSilenceLimitMs(bot), longGap + stallPollIntervalMsForThreshold(longGap));
            assert.ok(watchdogSilenceLimitMs(bot) > collapsed);
            assert.ok(watchdogSilenceLimitMs(bot) >= floor);
        } finally {
            stopEventLoopStallGuard(bot);
            Date.now = realNow;
        }
    });

    it('gaps that are all shorter than the server interval stay at that interval', () => {
        const realNow = Date.now;
        let now = 1_000_000;
        Date.now = () => now;
        const bot = { _client: new EventEmitter() };
        try {
            startEventLoopStallGuard(bot);
            bot._client.emit('keep_alive');
            now += SHORT_GAP_MS;
            bot._client.emit('keep_alive');
            now += Math.floor(SHORT_GAP_MS / 2);
            bot._client.emit('keep_alive');
            assert.strictEqual(stallThresholdMs(bot), KEEP_ALIVE_INTERVAL_MS);
            assert.strictEqual(bot.__keepAliveGapMaxMs, SHORT_GAP_MS);
            assert.strictEqual(
                watchdogSilenceLimitMs(bot),
                KEEP_ALIVE_INTERVAL_MS + stallPollIntervalMsForThreshold(KEEP_ALIVE_INTERVAL_MS),
            );
        } finally {
            stopEventLoopStallGuard(bot);
            Date.now = realNow;
        }
    });

    it('the 06:40 idle hold, with no phase and no bot API call, is not SIGKILLed', { timeout: KEEP_ALIVE_INTERVAL_MS }, async () => {
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
});
