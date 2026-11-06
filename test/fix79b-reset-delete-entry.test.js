/**
 * fix79b: reset_bug_poisoned.js delete_entry_where — delete exactly one list entry matched by deep equality on the listed fields.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkManifest, applyManifest } from '../scripts/reset_bug_poisoned.js';

const BAD = { target: 'scanForIronOreBlocks', kind: 'callee_fix', path: ['scanForIronOreBlocks'], task: 'Mine 1 diamond_ore', defers: 3 };
const OTHER = { target: 'scanForIronOreBlocks', kind: 'callee_fix', path: ['scanForIronOreBlocks'], task: 'Mine 1 iron_ore', defers: 1 };
const where = { target: 'scanForIronOreBlocks', kind: 'callee_fix', path: ['scanForIronOreBlocks'], task: 'Mine 1 diamond_ore' };
const manifest = w => ({ version: 1, bot: 't', files: { index: 'skills/index.json', progress: 'skills/progress.json' },
    records: [{ id: 'dr', file: 'progress', path: ['deferredRepairs'], delete_entry_where: w }] });

function bot(deferredRepairs) {
    const dir = mkdtempSync(join(tmpdir(), 'fix79b-'));
    mkdirSync(join(dir, 'skills'));
    writeFileSync(join(dir, 'skills/index.json'), '[]');
    writeFileSync(join(dir, 'skills/progress.json'), JSON.stringify({ deferredRepairs }));
    return dir;
}
const progress = dir => JSON.parse(readFileSync(join(dir, 'skills/progress.json'), 'utf8'));

describe('fix79b delete_entry_where', () => {
    it('0 matches throws (and writes nothing)', () => {
        const dir = bot([OTHER]);
        try {
            assert.throws(() => applyManifest({ manifest: manifest(where), botsDir: dir, apply: true, log: () => {} }), /matched 0 entries of deferredRepairs \(needs exactly 1\)/);
            assert.deepStrictEqual(progress(dir).deferredRepairs, [OTHER]);
        } finally { rmSync(dir, { recursive: true }); }
    });
    it('2 matches throws (and writes nothing)', () => {
        const dir = bot([BAD, { ...BAD, defers: 5 }]);
        try {
            assert.throws(() => applyManifest({ manifest: manifest(where), botsDir: dir, apply: true, log: () => {} }), /matched 2 entries/);
            assert.strictEqual(progress(dir).deferredRepairs.length, 2);
        } finally { rmSync(dir, { recursive: true }); }
    });
    it('a listed field must be equal in depth: a different path array does not match', () => {
        const dir = bot([{ ...BAD, path: ['mineOneDiamondOre', 'scanForIronOreBlocks'] }]);
        try { assert.throws(() => applyManifest({ manifest: manifest(where), botsDir: dir, apply: false, log: () => {} }), /matched 0 entries/); }
        finally { rmSync(dir, { recursive: true }); }
    });
    it('1 match: the dry run prints the deletion and writes nothing; apply deletes only that entry', () => {
        const dir = bot([OTHER, BAD]);
        try {
            const logs = [];
            const dry = applyManifest({ manifest: manifest(where), botsDir: dir, apply: false, log: s => logs.push(s) });
            assert.deepStrictEqual(dry.changes, [{ id: 'dr', op: 'delete_entry', target: 'deferredRepairs[1]', before: BAD, after: undefined }]);
            assert.ok(logs.some(l => l === `[reset-bug-poisoned] delete_entry deferredRepairs[1]: ${JSON.stringify(BAD)} -> undefined`), logs.join('\n'));
            assert.ok(logs.some(l => /dry-run only/.test(l)));
            assert.deepStrictEqual(progress(dir).deferredRepairs, [OTHER, BAD]);
            applyManifest({ manifest: manifest(where), botsDir: dir, apply: true, log: () => {} });
            assert.deepStrictEqual(progress(dir).deferredRepairs, [OTHER]);
        } finally { rmSync(dir, { recursive: true }); }
    });
    it('the path must hold a list', () => {
        const dir = bot({ a: BAD });
        try { assert.throws(() => applyManifest({ manifest: manifest(where), botsDir: dir, apply: false, log: () => {} }), /is not a list/); }
        finally { rmSync(dir, { recursive: true }); }
    });
    it('required fields only: empty or non-object match, or expect/delete_path beside it, is rejected', () => {
        assert.throws(() => checkManifest(manifest({})), /non-empty object/);
        assert.throws(() => checkManifest(manifest([BAD])), /non-empty object/);
        assert.throws(() => checkManifest({ ...manifest(where), records: [{ ...manifest(where).records[0], expect: BAD }] }), /its own operation/);
        assert.throws(() => checkManifest({ ...manifest(where), records: [{ id: 'dr', file: 'progress', delete_entry_where: where }] }), /needs path/);
    });
});
