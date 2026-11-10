// fix99 pointed three different checks at the keep-alive kick bound. Each one has its own source.
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Coder } from '../src/agent/coder.js';
import { Voyager } from '../src/agent/voyager.js';
import { nearbyBlockRadius, simulationBlockRadius } from '../src/agent/library/world.js';
import {
    stallThresholdMs, runStallPollTickForTest, KEEP_ALIVE_INTERVAL_MS, KEEP_ALIVE_KICK_MS, watchdogSilenceLimitMs,
} from '../src/utils/event_loop_guard.js';
import { noteBotApiDuration, setBotApiDurationStore, _clearBotApiDurationStoreForTest } from '../src/utils/bot_api_timing.js';

// Login (play) viewDistance and simulationDistance are chunk radii (minecraft-data pc/1.20.3
// protocol.json; https://wiki.vg/Protocol#Login_.28play.29). One chunk is CHUNK_WIDTH blocks.
const { CHUNK_WIDTH } = createRequire(import.meta.url)('prismarine-chunk/src/pc/common/constants.js');
const VIEW_CHUNKS = 6;
const SIM_CHUNKS = 4;

describe('fix99: the STALL log is a pending keep-alive', () => {
    it('a delay under the keep-alive interval is quiet, and a delay of that interval logs', () => {
        const bot = { __eventLoopStallThresholdMs: 1 };
        assert.strictEqual(stallThresholdMs(bot), KEEP_ALIVE_INTERVAL_MS);
        assert.notStrictEqual(KEEP_ALIVE_INTERVAL_MS, KEEP_ALIVE_KICK_MS);
        assert.strictEqual(watchdogSilenceLimitMs(), KEEP_ALIVE_KICK_MS);
        let saw = '';
        const orig = console.error;
        console.error = (msg) => { saw += String(msg); };
        try {
            bot.__stallEventLoopHist = { max: KEEP_ALIVE_INTERVAL_MS * 1e6 - 1, reset() {} };
            runStallPollTickForTest(bot);
            assert.strictEqual(saw, '');
            bot.__stallEventLoopHist = { max: KEEP_ALIVE_INTERVAL_MS * 1e6, reset() {} };
            runStallPollTickForTest(bot);
        } finally {
            console.error = orig;
        }
        assert.match(saw, /keep-alive is pending/);
        assert.match(saw, new RegExp(String(KEEP_ALIVE_INTERVAL_MS)));
        assert.doesNotMatch(saw, /one game tick/);
    });
});

describe('fix99: bot API timing uses recorded durations of that method', () => {
    it('a call longer than the recorded maximum names that maximum', () => {
        _clearBotApiDurationStoreForTest();
        assert.throws(() => noteBotApiDuration('blockAt', 1), /duration store is not attached/);
        const store = {};
        setBotApiDurationStore(store);
        assert.strictEqual(noteBotApiDuration('blockAt', 4), null);
        const over = noteBotApiDuration('blockAt', 9);
        assert.deepStrictEqual(over, { max: 4, n: 1 });
        assert.strictEqual(store.blockAt.max, 9);
        assert.strictEqual(store.blockAt.n, 2);
        assert.strictEqual(noteBotApiDuration('findBlocks', 9), null);
    });

    it('a stored record whose n is not an integer, or whose max is not finite, throws before it is changed', () => {
        const badCount = { blockAt: { n: 'x', max: 1 } };
        setBotApiDurationStore(badCount);
        assert.throws(() => noteBotApiDuration('blockAt', 1), /n must be an integer and max a finite number/);
        assert.deepStrictEqual(badCount.blockAt, { n: 'x', max: 1 });
        const badMax = { blockAt: { n: 1, max: Number.POSITIVE_INFINITY } };
        setBotApiDurationStore(badMax);
        assert.throws(() => noteBotApiDuration('blockAt', 1), /n must be an integer and max a finite number/);
        assert.deepStrictEqual(badMax.blockAt, { n: 1, max: Number.POSITIVE_INFINITY });
        const good = { findBlocks: { n: 2, max: 4 } };
        setBotApiDurationStore(good);
        assert.strictEqual(noteBotApiDuration('findBlocks', 3), null);
        assert.strictEqual(good.findBlocks.n, 3);
        assert.strictEqual(good.findBlocks.max, 4);
        _clearBotApiDurationStoreForTest();
    });
});

describe('fix99: a scan past the server view distance is flagged in blocks', () => {
    it('findBlocks one block past the granted view distance warns, and the radius itself does not', async () => {
        // The distances the lint reads are the ones mineflayer stored from Login (play).
        const client = new EventEmitter();
        const bot = {
            _client: client,
            supportFeature(name) { return name === 'dimensionIsAString' || name === 'customChannelIdentifier'; },
            emit() {},
            registry: { dimensionsByName: {} },
        };
        client.registerChannel = () => {};
        client.writeChannel = () => {};
        createRequire(import.meta.url)('mineflayer/lib/plugins/game.js')(bot, { brand: 'test' });
        client.emit('login', { dimension: 'overworld', gameMode: 0, maxPlayers: 20, viewDistance: VIEW_CHUNKS, simulationDistance: SIM_CHUNKS });
        const coder = new Coder({ name: 'scan', bot });
        const radius = nearbyBlockRadius(bot);
        assert.strictEqual(radius, VIEW_CHUNKS * CHUNK_WIDTH);
        const over = `async function main(bot) {\n    return bot.findBlocks({ matching: 1, maxDistance: ${radius + 1}, count: 1 });\n}\n`;
        const hits = coder._largeWorldScanLint(over, 0);
        assert.strictEqual(hits.length, 1);
        assert.match(hits[0].detail, new RegExp(`view distance \\(${VIEW_CHUNKS} chunks, ${radius} blocks\\)`));
        assert.doesNotMatch(hits[0].detail, /keep-alive|30000/);
        const atRadius = `async function main(bot) {\n    return bot.findBlocks({ matching: 1, maxDistance: ${radius}, count: 1 });\n}\n`;
        assert.strictEqual(coder._largeWorldScanLint(atRadius, 0).length, 0);
        const bare = new Coder({ name: 'scan-missing', bot: {} });
        assert.throws(() => bare._largeWorldScanLint(over, 0), /viewDistance/);
        const sim = simulationBlockRadius(bot);
        const entity = `async function main(bot) {\n    return bot.nearestEntity(() => true, ${sim + 1});\n}\n`;
        const entityHits = coder._largeWorldScanLint(entity, 0);
        assert.strictEqual(entityHits.length, 1);
        assert.match(entityHits[0].detail, new RegExp(`simulation distance \\(${SIM_CHUNKS} chunks, ${sim} blocks\\)`));
        const warns = [];
        const orig = console.warn;
        console.warn = (msg) => warns.push(String(msg));
        let lint;
        try {
            lint = await coder._lintCode(over, 0);
        } finally {
            console.warn = orig;
        }
        assert.strictEqual(lint, null);
        assert.match(warns.join('\n'), /view distance/);
    });
});

describe('fix99: progress.botApiDurations is initialised only when absent, and a wrong type throws', () => {
    const names = ['fix99-durations-absent', 'fix99-durations-array', 'fix99-durations-null'];
    const booted = [];
    after(() => {
        for (const v of booted) if (v._saveTimer) clearTimeout(v._saveTimer);
        for (const name of names) rmSync(join('bots', name), { recursive: true, force: true });
        _clearBotApiDurationStoreForTest();
    });

    function boot(name, progress) {
        const dir = join('bots', name, 'skills');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'progress.json'), JSON.stringify(progress));
        const v = new Voyager({
            name,
            fatal() {},
            bot: { version: '1.20.4', chat() {}, on() {}, off() {}, once() {}, removeListener() {}, inventory: { emptySlotCount: () => 36 } },
        });
        booted.push(v);
        return v;
    }

    it('a missing key starts as an object, and an array or null throws', () => {
        const absent = boot('fix99-durations-absent', { completed: [], failed: [], enabled: true, goalStats: {}, goalFailStates: [] });
        assert.deepStrictEqual(absent.progress.botApiDurations, {});
        assert.throws(
            () => boot('fix99-durations-array', { completed: [], failed: [], enabled: true, goalStats: {}, goalFailStates: [], botApiDurations: [] }),
            /progress\.botApiDurations must be an object/,
        );
        assert.throws(
            () => boot('fix99-durations-null', { completed: [], failed: [], enabled: true, goalStats: {}, goalFailStates: [], botApiDurations: null }),
            /progress\.botApiDurations must be an object/,
        );
    });
});
