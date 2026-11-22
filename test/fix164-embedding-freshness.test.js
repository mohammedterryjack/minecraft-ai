/**
 * fix164 — write-side embedding freshness invariant (learning-investigation-20261121.md).
 *
 * split/repair/restore/mutation paths change an entry's description/code without re-embedding,
 * leaving a stale vector in index.json that every cosine consumer reads. Evidence: the fix161
 * dup gate aliased retreatToRandomNearbyLocation onto navigateToHoglinAvoidingPillagers via a
 * stale pre-split embedding; the fresh descriptions score cosine 0.65. _flushSkills now drops
 * any embedding whose _embHash (fix35) does not match the current description/code; null is
 * what retrieveSkills' lazy re-embed repairs and what every consumer already skips.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Voyager } from '../src/agent/voyager.js';

describe('fix164: _flushSkills persists embeddings only while fresh', () => {
    const mk = () => {
        const v = Object.create(Voyager.prototype);
        v.indexFile = join(mkdtempSync(join(tmpdir(), 'fix164-')), 'index.json');
        v._saveTimer = null; v._skillsDirty = true;
        return v;
    };
    it('drops a stale embedding and keeps a fresh one', () => {
        const fresh = { name: 'a', description: 'Fetch water', code: 'async function a(bot){}', embedding: [1, 0] };
        fresh._embHash = Voyager.prototype._embHash(fresh);
        const stale = { name: 'b', description: 'Survive first by healing and retreating', code: 'async function b(bot){}', embedding: [0, 1], _embHash: 'zzz' };
        const v = mk();
        v.skills = [fresh, stale];
        v._flushSkills();
        const out = JSON.parse(readFileSync(v.indexFile, 'utf8'));
        assert.deepStrictEqual(out.find(e => e.name === 'a').embedding, [1, 0]);
        assert.strictEqual(out.find(e => e.name === 'b').embedding, null);
        assert.strictEqual('_embHash' in out.find(e => e.name === 'b'), false);
    });
    it('drops an embedding when only the code changed (hash covers description+code)', () => {
        const e = { name: 'c', description: 'Mine iron', code: 'async function c(bot){}', embedding: [1, 1] };
        e._embHash = Voyager.prototype._embHash(e);
        e.code = 'async function c(bot){ /* repaired */ }';
        const v = mk();
        v.skills = [e];
        v._flushSkills();
        assert.strictEqual(JSON.parse(readFileSync(v.indexFile, 'utf8'))[0].embedding, null);
    });
    it('is a no-op for entries without embeddings', () => {
        const v = mk();
        v.skills = [{ name: 'd', description: 'x', code: 'y' }];
        v._flushSkills();
        assert.strictEqual(JSON.parse(readFileSync(v.indexFile, 'utf8'))[0].embedding, undefined);
    });
});
