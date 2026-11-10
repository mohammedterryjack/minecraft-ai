// fix96b (live iMac logs, 9 Nov 2026): no prompt text is cut anywhere, and the repair prompts that reached 33k chars are
// made of what the repair needs, once.
//  - Cuts removed: execution output (first/last 250 chars), feedback (800/1500/2500), behaviour log (400/500), critic
//    feedback (300), lint evidence (600), API-gate errors (8), contract code (1800), stored evidence/desc (200), repair
//    lessons (150/200/300/500), workflows, practice goals (100), recipe forms (3 of N, 6 items), trace args (120), returns
//    (60), failure lines (4 / 200 chars), trace length (40/60 calls), chat memory (500), the joint reply in the log (1500).
//  - Repair prompts swelled from: (1) the API gate rejected the marker binding a repair had to keep (markerCallsMissing), so
//    every repair of collectBlock/ensureCraftingTable/craftRecipe failed attempt 1 and the retry pasted the whole rejected
//    candidate (live 16-23k-char retries); (2) the callers of the skill listed as callable (a cycle); (3) the closure listed
//    twice; (4) own repair proposals shown twice (history and lessons); (5) joint/refactor/split listed every built-in or the
//    whole library; (6) traces repeating identical loop iterations (live "collectItem (767 calls)").
//  - A prompt that does not fit fails that call loudly; the step loop does not exit on it (no restart loop).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('fix96b: nothing is cut from prompt text', () => {
    it('extractFeedback is the whole output; identical consecutive lines are written once with their count', async () => {
        const { extractFeedback } = await import('../src/agent/voyager.js');
        const out = ['start', ...Array(50).fill('FAILED: no oak_log within 32'), 'x'.repeat(5000), 'end'].join('\n');
        const fb = extractFeedback(out);
        assert.strictEqual(fb, ['start', 'FAILED: no oak_log within 32 (x50)', 'x'.repeat(5000), 'end'].join('\n'));
        assert.throws(() => extractFeedback(out, 1500), /takes the output only/);
    });

    it('the execution output, behaviour log, chat memory and practice goals are not cut', () => {
        assert.doesNotMatch(read('src/agent/action_manager.js'), /MAX_OUT|has been shortened/);
        assert.doesNotMatch(read('src/agent/agent.js'), /MAX_LOG/);
        assert.doesNotMatch(read('src/agent/history.js'), /Memory truncated/);
        assert.doesNotMatch(read('src/agent/idle_practice.js'), /toLowerCase\(\)\.slice\(0, 100\)|\.slice\(0, 200\)/);
        assert.doesNotMatch(read('src/agent/repair_memory.js'), /errorRaw: String\(errorSignature\)\.slice|fixSnippet\.slice|errorRaw\.slice|steps\.slice\(0, 10\)/);
        const v = read('src/agent/voyager.js');
        for (const cut of ['flushBehaviorLog().slice(', "String(res.message || '').slice(", 'String(feedback).slice(', 'API_LINT_EVIDENCE_CHARS', 'String(e.code).slice(0, 1800)',
            'evidence: q.evidence.slice(', 'desc.slice(0, 200)', "String(reply).slice(0, 1500)", 'forms.slice(0, 3)', 'code?.slice(0, 300)', 'extractFeedback(q.trace ||', 'traceText(trace, 60)'])
            assert.ok(!v.includes(cut), `voyager.js still cuts: ${cut}`);
        assert.doesNotMatch(read('src/agent/coder.js'), /\[\.\.\.errs\]\.slice/);
    });

    it('recipe facts list every form; forms that differ in one ingredient are written once with the alternatives', async () => {
        (await import('../src/utils/mcdata.js'))._setVersionForTest('1.20.4');
        const { recipeFormsText } = await import('../src/agent/voyager.js');
        const { getItemCraftingRecipes } = await import('../src/utils/mcdata.js');
        const table = recipeFormsText('crafting_table', getItemCraftingRecipes('crafting_table'));
        for (const p of ['oak_planks', 'cherry_planks', 'bamboo_planks', 'crimson_planks']) assert.ok(table.includes(p), p);
        assert.match(table, /^crafting_table: 4 oak_planks\|/);
        const bed = recipeFormsText('white_bed', getItemCraftingRecipes('white_bed'));
        assert.match(bed, /\+ 3 white_wool -> 1 white_bed/);
        assert.match(bed, /\+ 1 white_dye -> 1 white_bed/);
        // every recipe is still there: each plank and each dyed bed appears
        for (const r of getItemCraftingRecipes('white_bed')) for (const k of Object.keys(r[0])) assert.ok(bed.includes(k), k);
        assert.ok(!bed.includes('more'));
    });
});

describe('fix96b: traces are whole, and loops are counted, not cut', () => {
    it('a block argument is its name and position; identical repeated subtrees are written once with their count', async () => {
        const { instrumentSrc, traceText } = await import('../src/agent/skill_graph.js');
        const inst = instrumentSrc(['collectBlock']);
        const valText = new Function(`${inst.match(/const __gameObj = [^\n]+/)[0]}\n${inst.match(/const __valText = [\s\S]+?\n};/)[0]}; return __valText;`)();
        assert.strictEqual(valText({ type: 48, name: 'birch_log', position: { x: -67, y: 77, z: 78 }, biome: { name: '' }, light: 0 }), 'birch_log@-67,77,78');
        assert.strictEqual(valText({ item: 'stick', count: 2 }), '{"item":"stick","count":2}');
        assert.match(inst, /args: __argText\(a\.slice\(1\)\),/);
        assert.match(inst, /rec\.ret = __valText\(r\);/);
        const rec = (name, depth, parent, extra) => ({ name, args: '[]', depth, parent, ret: 'false', ok: false, delta: {}, ownFail: [], ...extra });
        const trace = [rec('collectItem', 0, -1)];
        for (let i = 0; i < 60; i++) {
            const p = trace.push(rec('collectLogs', 1, 0)) - 1;
            trace.push(rec('mineBlocks', 2, p, { args: '["birch_log",4]', ownFail: ['FAILED: No birch_log found', 'FAILED: No birch_log found'] }));
        }
        trace.untraced = 3;
        const text = traceText(trace);
        assert.strictEqual(text, [
            'collectItem() -> false FAIL',
            '  collectLogs() -> false FAIL (x60: this call and the 1 under it ran 60 times in a row, identically)',
            '    mineBlocks("birch_log",4) -> false FAIL | FAILED: No birch_log found (x2)',
            "(3 further call(s) ran after the trace's 121 records and were not recorded)",
        ].join('\n'));
    });
});

describe('fix96b: repair prompts carry what the repair needs, once', () => {
    it('the gate accepts the marker exactly when the replaced code calls it, and a repair adds no new marker call', async () => {
        const { markerGateNames, markerCallsMissing } = await import('../src/agent/skill_graph.js');
        const M = '__mcPreconditionUnmet__';
        const cur = `async function collectBlock(bot, t, n) { if (!bot) ${M}(bot, { need: { item: t, count: n, reason: 'reach' } }); return false; }`;
        assert.deepStrictEqual(markerGateNames(cur, M), [M]);
        assert.deepStrictEqual(markerGateNames('async function f(bot) { return 1; }', M), []);
        assert.strictEqual(markerCallsMissing(cur, cur.replace('return false', 'log(bot, "x"); return false'), M), null);
        assert.match(markerCallsMissing(cur, cur.replace('return false;', `${M}(bot, { need: { item: 'x', count: 1, reason: 'tool' } }); return false;`), M), /adds __mcPreconditionUnmet__ call/);
        assert.match(markerCallsMissing(cur, 'async function collectBlock(bot) { return false; }', M), /repair dropped/);
        const v = read('src/agent/voyager.js');
        assert.match(v, /const markerGap = body !== null \? markerCallsMissing\(e\.code, body, PRECONDITION_UNMET_BINDING\) : null;\n\s*const gate = shape === null && !markerGap/);
    });

    it('a retry shows the rejected candidate as the shorter of its diff and itself', async () => {
        const { lineDiff, repairRetrySuffix } = await import('../src/agent/repair_attempt.js');
        const current = Array.from({ length: 200 }, (_, i) => `    line ${i};`).join('\n');
        const candidate = current.replace('    line 100;', '    line 100; // fixed');
        const d = lineDiff(current, candidate);
        assert.strictEqual(d, ['  (current lines 1-100 unchanged)', '+     line 100; // fixed', '-     line 100;', '  (current lines 102-200 unchanged)'].join('\n'));
        const s = repairRetrySuffix({ candidate, reason: 'lint: x', identity: 'h', n: 1, current });
        assert.ok(s.includes(d) && !s.includes(candidate));
        const rewrite = Array.from({ length: 5 }, (_, i) => `other ${i}`).join('\n');
        assert.ok(repairRetrySuffix({ candidate: rewrite, reason: 'lint: x', identity: 'h', n: 1, current }).includes(rewrite));
        assert.throws(() => repairRetrySuffix({ candidate, reason: 'r', identity: 'h', n: 1 }), /current code/);
    });

    it('the repair prompt lists what the skill can call, names its callers once, and shows its own proposals once', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const { repairLessonInHistory } = await import('../src/agent/repair_attempt.js');
        const sk = (name, deps, code, extra) => ({ name, deps, code, description: `does ${name}`, ...extra });
        const v = Object.create(Voyager.prototype);
        v.skills = [
            sk('leaf', [], 'async function leaf(bot) { return true; }'),
            sk('target', ['leaf'], 'async function target(bot) { await leaf(bot); return getInventoryCounts(bot); }', { repairHistory: [{ kind: 'callee_fix', evidence: 'E1', desc: 'D1', outcome: 'failed' }] }),
            sk('callerA', ['target'], 'async function callerA(bot) { return target(bot); }'),
            sk('callerB', ['target'], 'async function callerB(bot) { return target(bot); }'),
        ];
        v.repairMemory = { formatHintsForCoder: ls => (ls.length ? `PAST REPAIR EXPERIENCE:\n${ls.map(l => l.fixSnippet).join('\n')}` : '') };
        const e = v.skills[1];
        const own = { skillName: 'target', errorRaw: 'E1', fixSnippet: 'D1' }, other = { skillName: 'otherSkill', errorRaw: 'E1', fixSnippet: 'D2' };
        assert.strictEqual(repairLessonInHistory(own, e), true);
        assert.strictEqual(repairLessonInHistory(other, e), false);
        const q = { kind: 'callee_fix', task: 't', path: ['callerA', 'target'], evidence: 'E1', trace: 'target() -> false FAIL', leaf: 'target' };
        const { system, user, sections } = v._repairPrompt(q, e, [own, other].filter(r => !repairLessonInHistory(r, e)));
        assert.match(system, /- leaf\(bot\): does leaf/);
        assert.match(system, /getInventoryCounts/);
        assert.doesNotMatch(system, /callerA|callerB|- target\(/, 'callers are not callable; the skill is not its own API');
        assert.match(user, /--- called by \(keep the signature compatible\) ---\ncallerA, callerB/);
        assert.doesNotMatch(user, /skills it uses/);
        assert.strictEqual(user.split('D1').length - 1, 1, 'own proposal once (history)');
        assert.ok(user.includes('D2'));
        assert.strictEqual(sections.callers, 'callerA, callerB'.length);
    });

    it('refactor/generalise/split list the functions the rewritten skills call, not the whole library', async () => {
        const v = read('src/agent/voyager.js');
        assert.ok(!v.includes('${this.unifiedAPIList()}'));
        assert.match(v, /\$\{this\.scopedAPIList\(ents\)\}/);
        assert.match(v, /\$\{this\.scopedAPIList\(\[e\]\)\}/);
        assert.match(v, /const jointApiList = this\.unifiedAPIList\(relevantSkills, jointBuiltIn\);/);
    });
});

describe('fix96b: a prompt that does not fit fails that call loudly; the bot keeps running', () => {
    const listen = handler => { const s = http.createServer(handler); return new Promise(r => s.listen(0, '127.0.0.1', () => r(s))); };
    it('the overflow 400 and a reply that reaches the end of the context carry CONTEXT_FULL', async () => {
        const { Ollama, CONTEXT_FULL } = await import('../src/models/ollama.js');
        let mode = 'overflow';
        const server = await listen((req, res) => {
            let raw = ''; req.on('data', c => { raw += c; });
            req.on('end', () => {
                if (mode === 'overflow') { res.statusCode = 400; res.end(JSON.stringify({ error: 'request (8243 tokens) exceeds the available context size (8192 tokens), try increasing it' })); return; }
                res.end(JSON.stringify({ message: { content: 'async function f(' }, done_reason: 'length', prompt_eval_count: 7000, eval_count: 1192, prompt_eval_duration: 1, eval_duration: 1, total_duration: 3, load_duration: 0 }));
            });
        });
        try {
            const o = new Ollama('coder', `http://127.0.0.1:${server.address().port}`, { keep_alive: -1, options: { num_ctx: 8192 } });
            await assert.rejects(() => o.sendRequest([{ role: 'user', content: 'u' }], 's'), e => e.code === CONTEXT_FULL && /prompt does not fit: 8243 tokens/.test(e.message));
            mode = 'length';
            await assert.rejects(() => o.sendRequest([{ role: 'user', content: 'u' }], 's'), e => e.code === CONTEXT_FULL && /\(7000 tokens\) \+ reply \(1192 tokens\) reached the context \(8192 tokens\)/.test(e.message));
        } finally { server.close(); }
    });

    it('CONTEXT_FULL decomposes the current task and blocks it when that is impossible; another repeated error still exits', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const { CONTEXT_FULL } = await import('../src/models/ollama.js');
        const v = Object.create(Voyager.prototype);
        const fatal = [];
        v.agent = { fatal: (where) => fatal.push(where) };
        v.progress = { failed: [], decomposed: {}, subgoals: [] };
        v.skills = [];
        v._saveProgress = () => {};
        const full = () => { const e = new Error('!!! [fix96] qwen3: prompt does not fit: 8243 tokens, context 8192 tokens'); e.code = CONTEXT_FULL; return e; };
        await assert.rejects(() => v._onStepError(full()), /prompt does not fit/);
        v.currentTask = 'Collect 1 oak_log';
        v._decompose = async () => false;
        await v._onStepError(full());
        assert.match(v._contextBlockReason('Collect 1 oak_log'), /prompt 8243 tokens, context 8192 tokens/);
        assert.deepStrictEqual(fatal, []);
        v._decompose = async () => true;
        await v._onStepError(full());
        assert.deepStrictEqual(fatal, []);
        const same = new Error('boom');
        v._onStepError(same); v._onStepError(same);
        assert.strictEqual(fatal.length, 1);
        // repair, joint repair, refactor, generalise, split and contract calls fail only that call (they catch and return false)
        const src = read('src/agent/voyager.js');
        for (const kind of ['repair', 'repair-joint', 'refactor', 'generalise', 'split', 'contract'])
            assert.match(src, new RegExp(`try \\{ [^\\n]*this\\._ask\\(system, user[^\\n]*'${kind}'[^\\n]*\\} catch \\(err\\) \\{ console\\.log`), kind);
    });
});
