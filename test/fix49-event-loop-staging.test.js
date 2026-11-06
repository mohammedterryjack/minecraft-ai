/**
 * fix49: event-loop stall threshold from observed server keep_alive; staging helpers.
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { setSettings } from '../src/agent/settings.js';
import { startEventLoopStallGuard, stopEventLoopStallGuard, stallThresholdMs } from '../src/utils/event_loop_guard.js';
import { collectBareApiUsedInSource } from '../src/agent/coder.js';

describe('fix49: server keep_alive stall threshold', () => {
    let _testBot;
    before(() => {
        setSettings({
            event_loop_stall_poll_interval_ms: 500,
        });
    });
    afterEach(() => {
        if (_testBot) stopEventLoopStallGuard(_testBot);
        _testBot = null;
    });

    it('stallThresholdMs throws until two inbound keep_alive packets are observed', () => {
        const bus = new EventEmitter();
        const bot = { _client: bus };
        _testBot = bot;
        startEventLoopStallGuard(bot);
        assert.throws(() => stallThresholdMs(bot), /not learned yet/);
        bus.emit('keep_alive', { keepAliveId: 1 });
        assert.throws(() => stallThresholdMs(bot), /not learned yet/);
    });

    it('stallThresholdMs equals observed gap between keep_alive packets', async () => {
        const bus = new EventEmitter();
        const bot = { _client: bus };
        _testBot = bot;
        startEventLoopStallGuard(bot);
        bus.emit('keep_alive', { keepAliveId: 1 });
        await new Promise((r) => setTimeout(r, 37));
        bus.emit('keep_alive', { keepAliveId: 2 });
        const t = stallThresholdMs(bot);
        assert.ok(t >= 30 && t <= 55, `expected ~37ms observed gap, got ${t}`);
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
});
