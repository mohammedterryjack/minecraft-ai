// fix202: the learned regen floor must explain the rise pattern, not merely the lowest level that ever
// saw a rise. Live data 27 Nov: regen[16] = 2 rises / 69768 samples (contamination) anchored the floor at
// 16 while levels 18-20 rise at 0.32-0.72; hp stalled at 2/20 with food 16 and the model believed regen
// was in progress (firstRise.f > food is false, blocked never fires).
import test from 'node:test';
import assert from 'node:assert/strict';
import { VitalsModel } from '../src/agent/vitals_model.js';

const mk = (buckets) => {
    const regen = {};
    for (const [f, n, up] of buckets) regen[f] = { n, up };
    return new VitalsModel({ regen, runs: {} });
};

test('fix202: a stray rise under a strong rising band no longer anchors the floor', () => {
    const v = mk([[0, 100, 0], [16, 69768, 2], [17, 133628, 0], [18, 113, 40], [19, 645, 208], [20, 1787, 1289]]);
    const rec = v.recovery(2, 20, 16);
    assert.equal(rec.firstRise.f, 18);
    assert.equal(rec.regenFood, false);
    assert.equal(v.hunger(2, 20, 16, 20).belowRegen, true);
});

test('fix202: a genuine low rise band still sets a low floor', () => {
    const v = mk([[11, 10, 5], [20, 100, 100]]);
    const rec = v.recovery(5, 20, 11);
    assert.equal(rec.firstRise.f, 11);
    assert.equal(rec.regenFood, true);
});

test('fix202: single observed rising level is the floor (cold start unchanged)', () => {
    const v = mk([[20, 50, 30], [15, 1000, 0]]);
    assert.equal(v.recovery(3, 20, 15).firstRise.f, 20);
});

test('fix202: no observed rise means no floor', () => {
    const v = mk([[10, 100, 0], [20, 100, 0]]);
    assert.equal(v.recovery(3, 20, 10).firstRise, null);
});

test('fix202: blocked still fires below the fitted floor', () => {
    const v = mk([[12, 500, 0], [18, 100, 40], [20, 500, 400]]);
    const rec = v.recovery(4, 20, 12);
    assert.equal(rec.firstRise.f, 18);
    assert.equal(rec.blocked, true);
});
