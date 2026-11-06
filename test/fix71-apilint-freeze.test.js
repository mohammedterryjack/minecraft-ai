/**
 * fix71 (live, after the #59/#60 deploy):
 *   [api-lint] QUEUED REPAIR of ensureFurnace: it does not lint against the current built-in API
 *   maturity ensureFurnace: V=0.68 ... -> FROZEN (mature skill kept)   => "[psn] repair of ensureFurnace skipped: maturity gate froze it"
 * Cause: _repair consulted the fix20/fix32 maturity gate for every code repair. V comes from runs of the incumbent under the
 * API it was written against; at V=0.68 P(update)=0.46, so a skill that cannot even be staged under the current API was kept
 * about half the time, and the frozen entry was dropped from the queue (not re-linted until the next restart).
 * Fix: the api-lint queue entry carries { api, hash }; _repair re-lints the skill against the current API and, while it still
 * fails, does not consult the gate (that record is evidence about code that no longer runs). Clean again -> repair dropped.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { Voyager } from '../src/agent/voyager.js';
import { Coder, getBareAPI } from '../src/agent/coder.js';

const NAME = '__fix71_test__';
after(() => rmSync(`./bots/${NAME}`, { recursive: true, force: true }));
const LIVE_ENSURE_FURNACE = readFileSync(new URL('./fixtures/fix67-live-ensureFurnace.js', import.meta.url), 'utf8');
const MATURE = { success: 10, fail: 2, streakFail: 0, tasks: ['Craft a furnace'] };   // V = 0.68, P(update) = 0.46
const REACHED = 'reached the code-model repair';

let coderP = null;
async function rig({ draw }) {
    coderP ||= (async () => { const c = new Coder({ name: NAME }); while (!c.code_lint_template || !c.code_template) await new Promise(r => setImmediate(r)); return c; })();
    const coder = await coderP;
    const v = Object.create(Voyager.prototype);
    v.agent = { coder, prompter: { code_model: { fallback: true } } };
    v.progress = {}; v._saveProgress = () => {}; v._saveSkills = () => {};
    v.repairMemory = { retrieveSimilar: async () => { throw new Error(REACHED); } };   // the first step after the gate
    v.skills = [...Voyager.SEEDED_PRIMITIVES.map(p => ({ name: p.name, code: p.code, deps: p.deps, contract: p.contract ? { ...p.contract, seeded: true } : undefined })),
        ...['mineOre', 'craftItem', 'getAllFreeSpaces'].filter(n => !getBareAPI().names.has(n)).map(n => ({ name: n, code: `async function ${n}(bot) {\n    return !!bot;\n}`, deps: [] })),
        { name: 'ensureFurnace', code: LIVE_ENSURE_FURNACE, deps: [], stats: structuredClone(MATURE) }];
    const gate = [];
    const realRandom = Math.random;
    Math.random = () => draw;
    const logs = []; const realLog = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    v.restore = () => { Math.random = realRandom; console.log = realLog; };
    v.logs = logs; v.gate = gate;
    return v;
}

describe('fix71: an API-lint failure overrides the maturity freeze', () => {
    it('live replay: V=0.68 and a freezing draw (0.99 >= P 0.46) no longer skip the queued api-lint repair', async () => {
        const v = await rig({ draw: 0.99 });
        try {
            assert.ok(Math.abs(v._maturity(v.skills.at(-1)).V - 0.68) < 0.005);
            assert.deepStrictEqual(await v._queueApiLintRepairs(), ['ensureFurnace']);
            assert.ok(v.logs.some(l => /\[api-lint\] QUEUED REPAIR of ensureFurnace/.test(l)));
            const q = v.progress.repairQueue[0];
            assert.deepStrictEqual(Object.keys(q.apiLint).sort(), ['api', 'hash']);
            assert.strictEqual(q.apiLint.api, v._apiSignature());
            await assert.rejects(v._repair(), new RegExp(REACHED));
            assert.ok(!v.logs.some(l => /maturity gate froze it/.test(l)), v.logs.join('\n'));
        } finally { v.restore(); }
    });

    it('the same draw still freezes a normal (non api-lint) repair of the same mature skill: the gate is unchanged', async () => {
        const v = await rig({ draw: 0.99 });
        try {
            v.progress.repairQueue = [{ target: 'ensureFurnace', leaf: 'ensureFurnace', path: ['ensureFurnace'], kind: 'callee_fix', evidence: 'FAILED: no furnace', task: 't', trace: '', depth: 0 }];
            assert.strictEqual(await v._repair(), false);
            assert.ok(v.logs.some(l => /repair of ensureFurnace skipped: maturity gate froze it/.test(l)));
        } finally { v.restore(); }
    });

    it('re-linted at repair time: code that lints clean again is not repaired, and is remembered clean for this API', async () => {
        const v = await rig({ draw: 0.99 });
        try {
            await v._queueApiLintRepairs();
            const e = v.skills.at(-1);
            e.code = LIVE_ENSURE_FURNACE.replace(/getBlockAtPosition\(\s*bot,\s*([^,]+),\s*([^,]+),\s*([^)]+?)\s*\)/g, 'getBlockAtOffset(bot, new Vec3($1, $2, $3))');
            assert.strictEqual(await v._repair(), false);
            assert.ok(v.logs.some(l => /repair of ensureFurnace dropped: it lints against the current API/.test(l)));
            assert.strictEqual(v.progress.apiLint.clean.ensureFurnace, v._skillHash(e));
        } finally { v.restore(); }
    });

    it('a repair already queued for the skill picks up the api-lint evidence once (no duplicate entry, no growing evidence)', async () => {
        const v = await rig({ draw: 0.99 });
        try {
            v.progress.repairQueue = [{ target: 'ensureFurnace', leaf: 'ensureFurnace', path: ['ensureFurnace'], kind: 'caller_fix', evidence: 'FAILED: no furnace', task: 't', trace: '', depth: 0 }];
            await v._queueApiLintRepairs();
            const ev = v.progress.repairQueue[0].evidence;
            await v._queueApiLintRepairs();
            assert.strictEqual(v.progress.repairQueue.length, 1);
            assert.strictEqual(v.progress.repairQueue[0].evidence, ev);
            assert.ok(v.progress.repairQueue[0].apiLint);
            await assert.rejects(v._repair(), new RegExp(REACHED));
        } finally { v.restore(); }
    });

    it('seeded primitives are never api-lint queued, so their seeded contracts are untouched', async () => {
        const v = await rig({ draw: 0.99 });
        try {
            const before = JSON.stringify(v.skills.filter(s => s.contract?.seeded).map(s => s.contract));
            await v._queueApiLintRepairs();
            const seeded = new Set(Voyager.SEEDED_PRIMITIVES.map(p => p.name));
            assert.ok(!v.progress.repairQueue.some(q => seeded.has(q.target)));
            assert.strictEqual(JSON.stringify(v.skills.filter(s => s.contract?.seeded).map(s => s.contract)), before);
        } finally { v.restore(); }
    });
});
