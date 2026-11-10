/**
 * fix49: event-loop stall threshold is the keep-alive kick bound; Nyquist poll; phase stack on STALL.
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import {
    startEventLoopStallGuard,
    stopEventLoopStallGuard,
    stallThresholdMs,
    runStallPollTickForTest,
    withStallPhase,
    KEEP_ALIVE_KICK_MS,
} from '../src/utils/event_loop_guard.js';
import { collectBareApiUsedInSource } from '../src/agent/coder.js';

describe('fix49: server keep_alive stall threshold', () => {
    let _testBot;
    afterEach(() => {
        if (_testBot) stopEventLoopStallGuard(_testBot);
        _testBot = null;
    });

    it('stallThresholdMs is the kick bound as soon as the guard starts, before any keep_alive', () => {
        const bus = new EventEmitter();
        const bot = { _client: bus };
        assert.throws(() => stallThresholdMs(bot), /kick bound/);
        _testBot = bot;
        startEventLoopStallGuard(bot);
        assert.strictEqual(stallThresholdMs(bot), KEEP_ALIVE_KICK_MS);
        bus.emit('keep_alive', { keepAliveId: 1 });
        assert.strictEqual(stallThresholdMs(bot), KEEP_ALIVE_KICK_MS);
    });

    it('a keep_alive gap shorter than the server interval leaves the threshold at the kick bound', () => {
        const bus = new EventEmitter();
        const bot = { _client: bus };
        _testBot = bot;
        const realNow = Date.now;
        let now = 1_000_000;
        Date.now = () => now;
        try {
            startEventLoopStallGuard(bot);
            bus.emit('keep_alive', { keepAliveId: 1 });
            now += 37;
            bus.emit('keep_alive', { keepAliveId: 2 });
            assert.strictEqual(stallThresholdMs(bot), KEEP_ALIVE_KICK_MS);
        } finally {
            Date.now = realNow;
        }
    });
});

describe('fix49: STALL logs capture phase stack at stall time (synthetic)', () => {
    it('attributes STALL to nested withStallPhase labels', async () => {
        const bot = {};
        bot.__eventLoopStallThresholdMs = 10;
        let saw = '';
        const origErr = console.error;
        console.error = (msg) => { saw += String(msg); };
        try {
            await withStallPhase('outer:phase', async () => {
                await withStallPhase('inner:blocking', async () => {
                    bot.__stallEventLoopHist = {
                        max: 50e6,
                        reset() {},
                    };
                    runStallPollTickForTest(bot);
                });
            });
        } finally {
            console.error = origErr;
        }
        assert.ok(saw.includes('[event-loop] STALL'), saw);
        assert.ok(saw.includes('outer:phase'), saw);
        assert.ok(saw.includes('inner:blocking'), saw);
        assert.ok(saw.includes('phase_stack='), saw);
    });
});

describe('fix49: collectBareApiUsedInSource', () => {
    it('detects bare Identifier call sites (AST), not string mentions', () => {
        const src = 'async function f(bot) { goToPosition(bot, 1,2,3); getNearestBlock(bot); const s = "goToPosition"; }';
        const used = collectBareApiUsedInSource(src);
        assert.ok(used.skillNames.has('goToPosition'));
        assert.ok(used.worldNames.has('getNearestBlock'));
        assert.ok(!used.skillNames.has('log'));
    });

    it('throws with parse error message on invalid JS (no empty catch)', () => {
        assert.throws(() => collectBareApiUsedInSource('async function x( {'), /parse failed/);
    });
});
