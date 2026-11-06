/**
 * fix76: reset_bug_poisoned.js — dry-run, apply, expect-mismatch, untouched records.
 * Fixtures mirror the reviewed poison inventory (scripts/bug_poisoned_manifest.json).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, cpSync, rmSync, existsSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadManifest, applyManifest } from '../scripts/reset_bug_poisoned.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MANIFEST = join(ROOT, 'scripts/bug_poisoned_manifest.json');
const FIX = join(HERE, 'fixtures/fix76-poisoned');
const FIX_BAD = join(HERE, 'fixtures/fix76-poisoned-mismatch');

function read(bots, file) { return JSON.parse(readFileSync(join(bots, 'skills', file), 'utf8')); }
function skill(index, name) { return index.find(s => s.name === name); }

describe('fix76 reset_bug_poisoned', () => {
    it('loads the reviewed manifest', () => {
        const m = loadManifest(MANIFEST);
        assert.strictEqual(m.version, 1);
        assert.strictEqual(m.bot, 'icefox2000');
        assert.ok(m.records.length >= 10);
        assert.ok(m.records.every(r => r.id && r.file && r.cause));
    });

    it('dry-run plans changes and leaves files untouched', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fix76-dry-'));
        cpSync(FIX, dir, { recursive: true });
        const beforeI = readFileSync(join(dir, 'skills/index.json'), 'utf8');
        const beforeP = readFileSync(join(dir, 'skills/progress.json'), 'utf8');
        const logs = [];
        const r = applyManifest({ manifest: loadManifest(MANIFEST), botsDir: dir, apply: false, log: s => logs.push(s) });
        assert.strictEqual(r.dryRun, true);
        assert.ok(r.changes.length >= 10);
        assert.strictEqual(readFileSync(join(dir, 'skills/index.json'), 'utf8'), beforeI);
        assert.strictEqual(readFileSync(join(dir, 'skills/progress.json'), 'utf8'), beforeP);
        assert.ok(logs.some(l => /dry-run only/.test(l)));
        rmSync(dir, { recursive: true, force: true });
    });

    it('apply backs up, resets poisoned records, leaves untouchedSkill alone', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fix76-apply-'));
        cpSync(FIX, dir, { recursive: true });
        const logs = [];
        const r = applyManifest({ manifest: loadManifest(MANIFEST), botsDir: dir, apply: true, log: s => logs.push(s) });
        assert.strictEqual(r.dryRun, false);
        assert.ok(r.backupDir && existsSync(join(r.backupDir, 'index.json')));
        assert.ok(existsSync(join(r.backupDir, 'progress.json')));

        const index = read(dir, 'index.json');
        const progress = read(dir, 'progress.json');
        const eat = skill(index, 'eatCookedMutton');
        assert.strictEqual(eat.demoted, false);
        assert.strictEqual(Object.hasOwn(eat, 'prunedAt'), false);
        assert.strictEqual(eat.stats.fail, 0);
        assert.strictEqual(eat.stats.streakFail, 0);
        assert.strictEqual(eat.stats.success, 1);
        assert.deepStrictEqual(eat.consumes, {});
        assert.strictEqual(eat.candidate, undefined);

        const travel = skill(index, 'travelWestAvoidDeathHotspot');
        assert.deepStrictEqual(travel.consumes, {});
        assert.deepStrictEqual(travel.effects, []);
        assert.strictEqual(travel.stats.success, 1);
        assert.strictEqual(travel.stats.practiceRuns, 316);

        const scan = skill(index, 'scanForIronOreBlocks');
        assert.strictEqual(scan.demoted, false);
        assert.strictEqual(scan.stats.fail, 0);
        assert.strictEqual(scan.stats.streakFail, 0);
        assert.strictEqual(scan.stats.success, 1);

        const keep = skill(index, 'untouchedSkill');
        assert.strictEqual(keep.demoted, false);
        assert.strictEqual(keep.stats.fail, 1);
        assert.deepStrictEqual(keep.consumes, { oak_log: 1 });
        assert.deepStrictEqual(keep.effects, ['oak_planks']);

        assert.strictEqual(progress.vitals.runs.eatCookedMutton, undefined);
        assert.strictEqual(progress.vitals.runs.checkInventoryForCookedMutton, undefined);
        assert.deepStrictEqual(progress.vitals.runs.mineOneIronOre, { n: 36, food: -8, hp: -10 });
        assert.strictEqual(progress.goalStats['eatCookedMutton::replay failed'], undefined);
        assert.strictEqual(progress.goalStats['Eat 1 cooked_mutton::failed 4x'], undefined);
        assert.strictEqual(progress.goalStats['Craft 1 iron_pickaxe::replay failed'], undefined);
        assert.strictEqual(progress.goalStats['Craft 1 iron_pickaxe::failed 4x'], undefined);
        assert.deepStrictEqual(progress.goalStats['Craft 1 iron_pickaxe::'], { success: 14, fail: 0 });
        assert.deepStrictEqual(progress.goalStats['Mine 1 iron_ore::replay failed'], { success: 0, fail: 8 });
        assert.deepStrictEqual(progress.completed, ['keep-me']);
        assert.ok(logs.some(l => /backup:/.test(l)));
        rmSync(dir, { recursive: true, force: true });
    });

    it('fails loud on expect mismatch and writes nothing', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fix76-bad-'));
        cpSync(FIX_BAD, dir, { recursive: true });
        const beforeI = readFileSync(join(dir, 'skills/index.json'), 'utf8');
        assert.throws(
            () => applyManifest({ manifest: loadManifest(MANIFEST), botsDir: dir, apply: true, log: () => {} }),
            /manifest expect mismatch/
        );
        assert.strictEqual(readFileSync(join(dir, 'skills/index.json'), 'utf8'), beforeI);
        rmSync(dir, { recursive: true, force: true });
    });
});
