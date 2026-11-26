// fix194: a candidate that never reaches a verdict must not block its skill's repairs forever.
// Root cause (live index.json 25 Nov): ~146 skills held a candidate (some from 17 Nov). Every repair of
// those skills logged "a candidate is already under trial", deferred 6 times, and DROPPED.
// Fix: CANDIDATE_TRIAL_DEADLINE_MS — a candidate with no verdict within the deadline is rejected like a
// failed trial (incumbent stays, proposal record says why); unstamped legacy candidates are overdue on sight.
process.env.PLAYFAB_MOCK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Voyager } from '../src/agent/voyager.js';

const stub = () => {
    const v = Object.create(Voyager.prototype);
    return Object.assign(v, {
        _noteProposal: (e, p) => { v.noted = p; },
        _saveSkills: () => { v.saved = (v.saved || 0) + 1; },
    });
};

test('fresh candidate (stamped now) is kept', () => {
    const v = stub({});
    const e = { name: 's1', candidate: { task: 't', candidateSince: Date.now() - 1000, stats: { success: 1, fail: 0 } } };
    assert.equal(v._expireStaleCandidate(e), false);
    assert.ok(e.candidate, 'fresh candidate must survive');
    assert.equal(v.noted, undefined, 'no rejection record for a fresh candidate');
});

test('candidate past the deadline is expired: removed, recorded, returns true', () => {
    const v = stub({});
    const e = { name: 's2', candidate: { task: 'repair: approach husk', candidateSince: Date.now() - 25 * 3600e3, stats: { success: 0, fail: 0 } } };
    assert.equal(v._expireStaleCandidate(e), true);
    assert.equal(e.candidate, undefined, 'expired candidate must be gone');
    assert.equal(v.noted.task, 'repair: approach husk');
    assert.equal(v.noted.outcome, 'rejected expired');
    assert.match(v.noted.evidence, /no verdict within 24h/);
});

test('legacy candidate with no candidateSince stamp is expired on sight', () => {
    const v = stub({});
    const e = { name: 's3', candidate: { task: 'split sp1794881962067', stats: { success: 1, fail: 1 } } };
    assert.equal(v._expireStaleCandidate(e), true);
    assert.equal(e.candidate, undefined);
    assert.equal(v.noted.task, 'split sp1794881962067');
});

test('legacy candidate with a non-string task still records a usable proposal', () => {
    const v = stub({});
    const e = { name: 's4', candidate: {} };
    assert.equal(v._expireStaleCandidate(e), true);
    assert.equal(e.candidate, undefined);
    assert.equal(v.noted.task, 'expired candidate of s4');
});

test('no candidate is a no-op', () => {
    const v = stub({});
    assert.equal(v._expireStaleCandidate({ name: 's5' }), false);
    assert.equal(v.noted, undefined);
});

test('the deferral site expires an overdue candidate before eating the deferral', async () => {
    // The wiring: in the repair queue, `if (e.candidate && this._expireStaleCandidate(e)) ...` precedes the
    // "already under trial" deferral, so an overdue candidate falls through instead of deferring 6 times.
    const src = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
    const expireAt = src.indexOf('if (e.candidate && this._expireStaleCandidate(e)) this._saveSkills();');
    const deferAt = src.indexOf('skipped: a candidate is already under trial');
    assert.ok(expireAt > 0, 'expire call must exist in the repair queue');
    assert.ok(deferAt > expireAt, 'the expire call must precede the deferral');
    // HOLD sites stamp candidateSince so new candidates get a real deadline
    const stamps = src.match(/cand\.candidateSince = Date\.now\(\)/g) || [];
    assert.equal(stamps.length, 2, 'both HOLD sites must stamp candidateSince');
    // boot sweep exists
    assert.match(src, /\[fix194\] boot: \$\{expired\} expired candidate/);
});
