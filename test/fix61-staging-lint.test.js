/**
 * fix61 regressions.
 * 1) A seeded primitive (a library skill copied from skills.js, e.g. breakBlockAt) is also a built-in, so the lint prelude
 *    declared it twice ("Identifier 'breakBlockAt' has already been declared") and every bundle holding one failed lint.
 * 2) #44 linted the PSN-instrumented bundle, so no-func-assign flagged the harness's own `name = __wrap("name", name)` lines:
 *    every replay (craftItem for "Craft 1 iron_pickaxe") failed lint before run and fell through to the code model, whose
 *    feedback named lines it never wrote -> identical prompts -> identical replies.
 * 3) Lint prelude declares the sandbox's pathfinder-goal endowments (seeded travelTo uses GoalNearXZ).
 * 4) A parse error inside the generated prelude fails loud instead of becoming model feedback; errors in code quote the line.
 * 5) [ollama] UNBOUNDED is logged once per model+endpoint until the bound is learned, chat and embed alike.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { rmSync } from 'fs';
import { Voyager } from '../src/agent/voyager.js';
import { Coder } from '../src/agent/coder.js';
import { instrumentSrc } from '../src/agent/skill_graph.js';
import { Ollama } from '../src/models/ollama.js';
import * as cd from '../src/models/call_durations.js';

const NAME = '__fix61_test__';
after(() => rmSync(`./bots/${NAME}`, { recursive: true, force: true }));

const CRAFT_ITEM = `async function craftItem(bot, itemName, target = 1) {
    const have = () => getInventoryCounts(bot)[itemName] || 0;
    if (!getNearestBlock(bot, 'crafting_table', 6) && !getInventoryCounts(bot)['crafting_table'])
        await goToNearestBlock(bot, 'crafting_table', 3, 48);
    for (let i = 0; i < target && have() < target; i++) {
        if (bot.interrupt_code) return false;
        if (!(await craftRecipe(bot, itemName, 1))) break;
    }
    return have() >= target;
}`;

async function rig() {
    const coder = new Coder({ name: NAME });
    while (!coder.code_lint_template || !coder.code_template) await new Promise(r => setImmediate(r));
    const v = Object.create(Voyager.prototype);
    v.skills = [...Voyager.SEEDED_PRIMITIVES.map(p => ({ name: p.name, code: p.code, deps: p.deps })), { name: 'craftItem', code: CRAFT_ITEM, deps: ['craftRecipe'] }];
    v.agent = { coder };
    return { v, coder };
}
const replayBundles = (v, name, call) => {
    const cl = new Set([name, ...v._closure(name)]);
    const lib = v._libSrcSubset(cl, {});
    const tail = '\n\nasync function __replay(bot) {\n    try { ' + call + ' } finally { bot.__psnOut = bot.output; }\n}\nawait __replay(bot);';
    return { cl, lintSrc: lib + tail, execSrc: lib + '\n\n' + instrumentSrc(Voyager._tracedSkillNamesForInstrument(v, cl, {})) + tail };
};

describe('fix61: staging declares each name once', () => {
    it('a closure whose skills share names with built-ins (breakBlockAt, craftRecipe, placeBlock...) has a parseable, duplicate-free prelude', async () => {
        const { v, coder } = await rig();
        const { cl, lintSrc } = replayBundles(v, 'craftItem', 'await craftItem(bot, "iron_pickaxe", 1);');
        assert.ok(cl.has('breakBlockAt') && cl.has('craftRecipe'), 'closure holds seeded primitives that shadow built-ins');
        const st = await coder._stageCode(lintSrc, { ...v._coderStageOpts(lintSrc, cl), lintOnly: true });
        const prelude = st.src_lint_copy.split('\n').slice(0, st.preludeLines - 1);
        const declared = prelude.map(l => (l.match(/^const (\w+) =/) || [])[1]).filter(Boolean);
        assert.deepStrictEqual(declared.filter((n, i) => declared.indexOf(n) !== i), [], 'no name declared twice in the prelude');
        assert.ok(declared.includes('breakBlockAt'));
    });
    it('the craftItem replay for iron_pickaxe lints clean and stages (instrumentation is not linted)', async () => {
        const { v } = await rig();
        const { cl, lintSrc, execSrc } = replayBundles(v, 'craftItem', 'await craftItem(bot, "iron_pickaxe", 1);');
        const { lint, staged } = await v._stageLintExecTraced(lintSrc, execSrc, cl, 'test:replay:craftItem');
        assert.strictEqual(lint, null, String(lint));
        assert.strictEqual(typeof staged.func.main, 'function');
    });
    it('linting the instrumented bundle (the #44 behaviour) is exactly what failed: no-func-assign on the harness __wrap lines', async () => {
        const { v } = await rig();
        const { cl, execSrc } = replayBundles(v, 'craftItem', 'await craftItem(bot, "iron_pickaxe", 1);');
        const { lint } = await v._stageLintExec(execSrc, cl, 'test:old');
        assert.match(String(lint), /'craftItem' is a function/);
    });
    it('every seeded primitive replays lint-clean, travelTo (GoalNearXZ) included', async () => {
        const { v } = await rig();
        for (const p of Voyager.SEEDED_PRIMITIVES) {
            const { cl, lintSrc, execSrc } = replayBundles(v, p.name, `await ${p.name}(bot);`);
            const { lint } = await v._stageLintExecTraced(lintSrc, execSrc, cl, `test:replay:${p.name}`);
            assert.strictEqual(lint, null, `${p.name}: ${lint}`);
        }
    });
    it('generated code calling a seeded primitive lints clean, so a later attempt is judged on its own code only', async () => {
        const { v } = await rig();
        const code = `// DESCRIPTION: craft one iron pickaxe\nasync function craftOnePick(bot) {\n    return await craftItem(bot, 'iron_pickaxe', 1);\n}\nawait craftOnePick(bot);`;
        const cl = new Set(['craftOnePick', 'craftItem', ...v._closure('craftItem')]);
        const lib = v.skills.filter(s => cl.has(s.name)).map(s => s.code).join('\n\n');
        const { lint } = await v._stageLintExecTraced(lib + '\n\n' + code, lib + '\n\n' + instrumentSrc(Voyager._tracedSkillNamesForInstrument(v, cl, {})) + '\n\n' + code, cl, 'test:writeCode');
        assert.strictEqual(lint, null, String(lint));
    });
});

describe('fix61: parse errors are attributed', () => {
    it('a parse error inside the generated prelude fails loud (never model feedback)', async () => {
        const { coder } = await rig();
        await assert.rejects(coder._lintCode('const a = 1;\nconst a = 2;\nexport async function main(bot) {\n}\n', 3), /\[fix61\] LOUD FAIL: staged lint prelude does not parse/);
    });
    it('a parse error in the code quotes the offending line', async () => {
        const { coder } = await rig();
        const out = await coder._lintCode('const a = 1;\nexport async function main(bot) {\n    let x = ;\n}\n', 2);
        assert.match(out, /Offending line: let x = ;/);
    });
});

describe('fix61: UNBOUNDED logged once per model+endpoint until a bound is learned', () => {
    const serve = () => new Promise(r => { let n = 0; const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { n++; setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ embeddings: [[1]], message: { content: 'ok' }, prompt_eval_count: 4, prompt_eval_duration: 1e6, eval_count: 2, eval_duration: 2e6, total_duration: 3e6, load_duration: 0 })); }, n % 2 ? 5 : 40); }); }); srv.listen(0, '127.0.0.1', () => r(srv)); });
    it('noteUnboundedCall is true once per key; takeLearnedBound fires once, when the bound appears', () => {
        cd.setCallDurationStore({});
        assert.strictEqual(cd.noteUnboundedCall('k /api/embed'), true);
        assert.strictEqual(cd.noteUnboundedCall('k /api/embed'), false);
        assert.strictEqual(cd.noteUnboundedCall('k /api/chat'), true, 'each endpoint has its own announcement');
        const shape = { chars: 8, genBudget: () => 0 };
        assert.strictEqual(cd.takeLearnedBound('k /api/embed', shape), null, 'nothing learned yet');
        cd.recordCall('k /api/embed', 10, 8, { pTok: 2, pMs: 4, gTok: 0, gMs: 0 });   // fix63: one call with reply counters gives the rates
        assert.deepStrictEqual(cd.takeLearnedBound('k /api/embed', shape), { calls: 2, bound: cd.callBound('k /api/embed', shape) });
        assert.strictEqual(cd.takeLearnedBound('k /api/embed', shape), null);
    });
    it('20 concurrent embeds + 3 chats on a fresh store print one UNBOUNDED line per endpoint', async () => {
        cd.setCallDurationStore({});
        const srv = await serve();
        const o = new Ollama('burst', `http://127.0.0.1:${srv.address().port}`, {});
        const lines = [], orig = console.log;
        console.log = (...a) => { lines.push(a.join(' ')); };
        try {
            await Promise.all(Array.from({ length: 20 }, () => o.embed('x')));
            for (let i = 0; i < 3; i++) await o.send('/api/chat', { model: 'burst', messages: [{ role: 'user', content: 'hi' }], options: { num_ctx: 64 } });
        } finally { console.log = orig; srv.close(); }
        assert.strictEqual(lines.filter(l => l.includes('UNBOUNDED calls burst /api/embed')).length, 1);
        assert.strictEqual(lines.filter(l => l.includes('UNBOUNDED calls burst /api/chat')).length, 1);
        assert.strictEqual(lines.filter(l => l.includes('burst /api/embed now bounded')).length, 1);
    });
});
