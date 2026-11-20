// fix148: noteBotApiDuration looked up _durations[name] through the prototype chain, so any bot method
// whose name collides with an Object.prototype member (valueOf, toString, constructor, __defineGetter__)
// read a function as the "previous record" and threw "[bot-api] recorded <name> duration ... n must be an
// integer and max a finite number" on EVERY such call. Live 20 Nov: 535x — Number()/String() coercion on
// the proxied bot calls bot.valueOf(), failing replays whose action had already succeeded (equipDiamondChestplate).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setBotApiDurationStore, noteBotApiDuration, _clearBotApiDurationStoreForTest } from '../src/utils/bot_api_timing.js';

test('prototype-member method names do not throw and record normally', () => {
    const store = JSON.parse('{}'); // same shape as the JSON-persisted progress store
    setBotApiDurationStore(store);
    try {
        assert.equal(noteBotApiDuration('valueOf', 5), null);
        assert.equal(noteBotApiDuration('valueOf', 3), null);
        // second call slower than the first: excess over the recorded max, not a throw
        assert.deepEqual(noteBotApiDuration('valueOf', 9), { max: 5, n: 2 });
        for (const name of ['toString', 'constructor', '__defineGetter__', 'hasOwnProperty']) {
            assert.equal(noteBotApiDuration(name, 2), null, name);
        }
        assert.equal(store.valueOf.n, 3);
        assert.equal(store.valueOf.max, 9);
    } finally {
        _clearBotApiDurationStoreForTest();
    }
});

test('a method literally named __proto__ cannot reassign the store prototype', () => {
    const store = JSON.parse('{}');
    setBotApiDurationStore(store);
    try {
        assert.equal(noteBotApiDuration('__proto__', 4), null);
        assert.equal(Object.getPrototypeOf(store), Object.prototype);
        // the own data property shadows the inherited setter-accessor; the prototype is untouched
        assert.deepEqual(store.__proto__, { n: 1, max: 4 });
    } finally {
        _clearBotApiDurationStoreForTest();
    }
});

test('ordinary methods keep the previous-record contract', () => {
    const store = JSON.parse('{}');
    setBotApiDurationStore(store);
    try {
        assert.equal(noteBotApiDuration('blockAt', 10), null);
        assert.equal(noteBotApiDuration('blockAt', 8), null);
        assert.deepEqual(noteBotApiDuration('blockAt', 12), { max: 10, n: 2 });
        assert.deepEqual(store.blockAt, { n: 3, max: 12 });
    } finally {
        _clearBotApiDurationStoreForTest();
    }
});
