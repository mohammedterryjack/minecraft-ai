/**
 * fix49: event-loop stall threshold tied to protocol keepalive; staging closure subset.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setSettings } from '../src/agent/settings.js';
import { protocolKeepaliveIntervalMs, stallThresholdMs } from '../src/utils/event_loop_guard.js';
import { collectBareApiUsedInSource } from '../src/agent/coder.js';

describe('fix49: protocol keepalive / stall threshold', () => {
    before(() => {
        setSettings({
            check_timeout_interval_ms: 60000,
            event_loop_stall_poll_interval_ms: 500,
        });
    });

    it('stallThresholdMs equals protocol keep-alive interval', () => {
        const bot = { _client: { checkTimeoutInterval: 60000 } };
        assert.strictEqual(protocolKeepaliveIntervalMs(bot), 60000);
        assert.strictEqual(stallThresholdMs(bot), 60000);
    });

    it('throws if settings interval mismatches bot client', () => {
        const bot = { _client: { checkTimeoutInterval: 30000 } };
        assert.throws(() => protocolKeepaliveIntervalMs(bot), /checkTimeoutInterval/);
    });
});

describe('fix49: collectBareApiUsedInSource', () => {
    it('detects bare skills.* calls used in source', () => {
        const src = 'async function f(bot) { goToPosition(bot, 1,2,3); getNearestBlock(bot); }';
        const used = collectBareApiUsedInSource(src);
        assert.ok(used.skillNames.size >= 1);
        assert.ok(used.worldNames.size >= 1);
    });
});
