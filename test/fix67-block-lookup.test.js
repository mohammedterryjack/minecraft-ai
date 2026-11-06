/**
 * fix67: the block lookup says its frame; nothing is inferred.
 * fix65 (#58) kept getBlockAtPosition(bot, x, y, z) relative and guessed "absolute" when the three numbers lay nearer the
 * bot than the origin. That guess misreads a real far offset (thrown at) and an absolute position near the world origin
 * (read as an offset). Now: getBlockAtOffset(bot, Vec3) is relative to the feet, getBlockAtAbsolute(bot, Vec3) is a world
 * position, and anything else throws. Learned skills written against the old form (the live ensureFurnace) no longer lint;
 * they are queued for a normal repair with the lint text as evidence, once per (API, skill version).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { Vec3 } from 'vec3';
import * as world from '../src/agent/library/world.js';
import { getSkillDocs } from '../src/agent/library/index.js';
import { Voyager } from '../src/agent/voyager.js';
import { Coder, getBareAPI } from '../src/agent/coder.js';

const NAME = '__fix67_test__';
after(() => rmSync(`./bots/${NAME}`, { recursive: true, force: true }));
const LIVE_ENSURE_FURNACE = readFileSync(new URL('./fixtures/fix67-live-ensureFurnace.js', import.meta.url), 'utf8');

function cellBot(cells, at) {
    const m = new Map(Object.entries(cells).map(([k, name]) => { const [x, y, z] = k.split(',').map(Number); const position = new Vec3(x, y, z); return [position.toString(), { name, position }]; }));
    return { entity: { position: at }, blockAt: (p) => m.get(p.floored().toString()) ?? null };
}

describe('fix67: relative and absolute lookups are separate', () => {
    it('a far relative offset is read as an offset (fix65 threw: it lay nearer the bot than the origin)', () => {
        const bot = cellBot({ '-223,33,108': 'stone' }, new Vec3(-122.3, 33, 58.7));
        assert.strictEqual(world.getBlockAtOffset(bot, new Vec3(-100, 0, 50)).name, 'stone');
    });
    it('an absolute position near the world origin is read as absolute (fix65 read it as an offset)', () => {
        const bot = cellBot({ '1,63,1': 'dirt', '4,127,3': 'glass' }, new Vec3(3.5, 64, 2.5));
        assert.strictEqual(world.getBlockAtAbsolute(bot, new Vec3(1, 63, 1)).name, 'dirt');
    });
    it('both return null for an unloaded chunk (unknown, never air)', () => {
        const bot = cellBot({}, new Vec3(0.5, 64, 0.5));
        assert.strictEqual(world.getBlockAtOffset(bot, new Vec3(0, -1, 0)), null);
        assert.strictEqual(world.getBlockAtAbsolute(bot, new Vec3(0, 63, 0)), null);
    });
    it('the old three-number form and non-Vec3 arguments throw and show the Vec3 form', () => {
        const bot = cellBot({}, new Vec3(0.5, 64, 0.5));
        assert.throws(() => world.getBlockAtOffset(bot, 0, -1, 0), /getBlockAtOffset\(bot, offset\) takes exactly one Vec3 .*new Vec3\(0, -1, 0\).*got 3 argument/);
        assert.throws(() => world.getBlockAtAbsolute(bot, { x: 1, y: 2, z: 3 }), /getBlockAtAbsolute\(bot, position\) takes exactly one Vec3/);
        assert.throws(() => world.getBlockAtAbsolute(bot), /got 0 argument/);
        assert.strictEqual(world.getBlockAtPosition, undefined, 'the ambiguous form is gone');
    });
});

describe('fix67: prompt API docs', () => {
    it('signatures and docstrings name the two lookups and their frames; the old name is nowhere', () => {
        const sigs = getBareAPI().sigs;
        assert.ok(sigs.includes('getBlockAtOffset(bot, offset)'), sigs.filter(s => /Block/.test(s)).join(' '));
        assert.ok(sigs.includes('getBlockAtAbsolute(bot, position)'));
        const docs = getSkillDocs().join('\n');
        assert.match(docs, /getBlockAtOffset\n[^]*RELATIVE to the bot's feet[^]*getBlockAtOffset\(bot, new Vec3\(0, -1, 0\)\)/);
        assert.match(docs, /getBlockAtAbsolute\n[^]*ABSOLUTE world position[^]*getBlockAtAbsolute\(bot, new Vec3\(-124, 33, 57\)\)/);
        assert.ok(!/getBlockAtPosition/.test(docs + sigs.join('\n')));
        const src = ['../src/agent/voyager.js', '../src/agent/library/skills.js', '../src/agent/library/full_state.js', '../src/agent/modes.js']
            .map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
        assert.ok(!/getBlockAtPosition\s*\(/.test(src), 'no caller or seeded copy uses the old form');
    });
});

describe('fix67: learned skills on the old form are migrated through lint -> repair', () => {
    async function rig() {
        const coder = new Coder({ name: NAME });
        while (!coder.code_lint_template || !coder.code_template) await new Promise(r => setImmediate(r));
        const v = Object.create(Voyager.prototype);
        v.agent = { coder }; v.progress = {}; v._saveProgress = () => {};
        const CLEAN = `async function standOnSolid(bot) {\n    const b = getBlockAtOffset(bot, new Vec3(0, -1, 0));\n    return !!b && b.name !== 'air';\n}`;
        v.skills = [...Voyager.SEEDED_PRIMITIVES.map(p => ({ name: p.name, code: p.code, deps: p.deps })),
            // learned skills the live ensureFurnace calls (bodies irrelevant: only their names are declared for lint)
            ...['mineOre', 'craftItem', 'getAllFreeSpaces'].filter(n => !getBareAPI().names.has(n)).map(n => ({ name: n, code: `async function ${n}(bot) {\n    return !!bot;\n}`, deps: [] })),
            { name: 'ensureFurnace', code: LIVE_ENSURE_FURNACE, deps: [] }, { name: 'standOnSolid', code: CLEAN, deps: [] }];
        return v;
    }
    it('the live ensureFurnace is queued for repair with the lint error as evidence; clean skills are remembered', async () => {
        const v = await rig();
        const broken = await v._queueApiLintRepairs();
        assert.deepStrictEqual(broken, ['ensureFurnace']);
        assert.strictEqual(v.progress.repairQueue.length, 1);
        const q = v.progress.repairQueue[0];
        assert.strictEqual(q.target, 'ensureFurnace'); assert.strictEqual(q.kind, 'callee_fix');
        assert.match(q.evidence, /does not lint against the current built-in API.*'getBlockAtPosition' is not defined/);
        assert.ok(v.progress.apiLint.clean.standOnSolid);
        assert.strictEqual(v.progress.apiLint.clean.ensureFurnace, undefined);
        assert.ok(!('travelTo' in v.progress.apiLint.clean), 'seeded primitives are repo-owned, not linted here');
    });
    it('a restart with the same API re-lints only what was not clean, and does not queue twice', async () => {
        const v = await rig();
        await v._queueApiLintRepairs();
        const lints = []; const real = v.agent.coder._lintCode.bind(v.agent.coder);
        v.agent.coder._lintCode = async (...a) => { lints.push(a[0]); return real(...a); };
        const broken = await v._queueApiLintRepairs();
        assert.deepStrictEqual(broken, ['ensureFurnace']);
        assert.strictEqual(lints.length, 1, 'standOnSolid was remembered as clean for this API');
        assert.strictEqual(v.progress.repairQueue.length, 1);
    });
    it('the repaired form (getBlockAtOffset with a Vec3) lints clean, so the trial gate can promote it', async () => {
        const v = await rig();
        const fixed = LIVE_ENSURE_FURNACE.replace(/getBlockAtPosition\(\s*bot,\s*([^,]+),\s*([^,]+),\s*([^)]+?)\s*\)/g, 'getBlockAtOffset(bot, new Vec3($1, $2, $3))');
        assert.ok(!/getBlockAtPosition/.test(fixed));
        v.skills = v.skills.map(s => s.name === 'ensureFurnace' ? { ...s, code: fixed } : s);
        assert.deepStrictEqual(await v._queueApiLintRepairs(), []);
    });
});
