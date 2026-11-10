/**
 * fix97: compose-retry #78 (fix96 1c2f9c0) overflowed qwen2.5-coder:7b.
 * Task: Collect 1 stripped_birch_wood, a subgoal of Craft 4 birch_planks.
 * Log: [prompt] kind=code-retry total=181705 chars: system=3721 skills=2192 prelude=3760 state=390 history=785 retry=170464 framing=393
 * The retry section was 170464/181705 chars (94%). Ollama then reported system=7481 tokens and the user message
 * 174224 chars, 58984 tokens in all, against num_ctx 8192. NEVER_CUT_PROMPT threw at ollama.js.
 * Attempt 1 hit its 5-minute timeout. Its trace had 789 calls, including collectLogs(4,"birch_log") -> false FAIL
 * 60 times, identically, interleaved with other calls. The bot could not break stone or reach birch_log.
 * Inventory: 0 empty slots, 1043 total items.
 * collapseRepeats only merges consecutive identical lines, so those 60 FAILs and the pathfinder lines (coordinates
 * and timestamps change) all stayed, and the behaviour log repeated the same lines as the trace and the output.
 * contextBlocked and promptCounts do not compact this feedback.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as cd from '../src/models/call_durations.js';
import { collapseRepeats, structuredTrace } from '../src/agent/skill_graph.js';
import { codeRetryFeedback } from '../src/agent/voyager.js';
import { CODE_PROMPT_DUMP, writeCodePromptDump } from '../src/models/code_prompt_dump.js';
import { CODE_RETRY_78, observedChatWork } from './fixtures/code_retry_observation.js';

const profile = JSON.parse(readFileSync(new URL('../profiles/mo_bot.json', import.meta.url), 'utf8'));
const NUM_CTX = profile.code_model.params.options.num_ctx;
const KEY = `${profile.code_model.model} /api/chat`;

// Same path as the live bound: workOf reads prompt_eval_count, recordCall stores chars/that as cpt,
// callBound estimates ceil(chars / cpt). The cpt is CODE_RETRY_78, the one live count. No local tokenizer.
function learnLiveDensity() {
    const work = observedChatWork();
    if (work.pTok !== CODE_RETRY_78.promptTokens) throw new Error(`workOf did not keep prompt_eval_count ${CODE_RETRY_78.promptTokens}`);
    cd.setCallDurationStore({});
    cd.recordCall(KEY, work.pMs + work.gMs, CODE_RETRY_78.totalChars, work);
    const learned = cd.callDurationStore()[KEY].cpt;
    if (learned !== CODE_RETRY_78.totalChars / CODE_RETRY_78.promptTokens) throw new Error(`cpt ${learned} is not the live count`);
    return learned;
}

function tokensOf(system, user) {
    const shape = cd.requestShape('/api/chat', {
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        options: { num_ctx: NUM_CTX },
    });
    const bound = cd.callBound(KEY, shape);
    if (typeof bound.pTok !== 'number') throw new Error(bound.why);
    const cpt = cd.callDurationStore()[KEY].cpt;
    return { tokens: bound.pTok, chars: shape.chars, roundedUpBy: bound.pTok - (shape.chars / cpt) };
}

function record(name, args, ok, ownFail, parent = -1, ret) {
    return { name, args, parent, depth: parent < 0 ? 0 : 1, ok, intr: false, fail: !ok, err: null, ownFail, ret: ret !== undefined ? ret : (ok ? 'true' : 'false'), o0: 0, o1: 0 };
}

describe('fix97 code-retry feedback is compact by construction', () => {
    it('789 calls keep every distinct error and outcome, and identical lines collapse to a count', () => {
        const sections = [CODE_RETRY_78.systemChars, CODE_RETRY_78.skillsChars, CODE_RETRY_78.preludeChars, CODE_RETRY_78.stateChars, CODE_RETRY_78.historyChars, CODE_RETRY_78.retryChars, CODE_RETRY_78.framingChars];
        assert.strictEqual(sections.reduce((sum, n) => sum + n, 0), CODE_RETRY_78.totalChars);
        assert.strictEqual(CODE_RETRY_78.totalChars - CODE_RETRY_78.userChars, CODE_RETRY_78.systemMessageChars);
        assert.strictEqual(NUM_CTX, CODE_RETRY_78.contextTokens);
        const cpt = learnLiveDensity();
        const sameShape = cd.requestShape('/api/chat', { messages: [{ role: 'user', content: 'x'.repeat(CODE_RETRY_78.totalChars) }], options: { num_ctx: NUM_CTX } });
        assert.strictEqual(cd.callBound(KEY, sameShape).pTok, CODE_RETRY_78.promptTokens);
        assert.strictEqual(cd.callDurationStore()[KEY].cpt, cpt);

        const trace = [];
        let collects = 0;
        for (let i = 0; i < 789; i++) {
            if (collects < 60 && i % 13 === 0) {
                trace.push(record('collectLogs', '[4,"birch_log"]', false, ['FAILED: cannot reach birch_log']));
                collects++;
                continue;
            }
            if (i % 3 === 0) {
                trace.push(record('goToPosition', `[${-90 - i},76,${40 + i},2]`, false, [
                    `Pathfinding stopped: Cannot break stone with current tools. [food ${16 + (i % 4)}/20 health 20/20]`,
                    `FAILED: pathfinding stopped (Path was stopped before it could be completed!); ${10 + (i % 50)} blocks from ${-90 - i}, 76, ${40 + i}.`,
                ]));
                continue;
            }
            if (i % 3 === 1) {
                trace.push(record('mineBlock', '["stone"]', false, ['FAILED: cannot break stone']));
                continue;
            }
            trace.push(record('equipBestTool', '["axe"]', true, []));
        }
        assert.strictEqual(trace.length, 789);
        assert.strictEqual(collects, 60);
        const interleaved = [];
        for (const r of trace) {
            if (r.name === 'collectLogs') interleaved.push('collectLogs(4,"birch_log") -> false FAIL');
            interleaved.push(`note ${r.name} at ${r.args}`);
        }
        assert.strictEqual(collapseRepeats(interleaved).filter(l => l.startsWith('collectLogs')).length, 60);

        const output = [];
        for (let i = 0; i < 400; i++) {
            output.push(`Pathfinding stopped: Cannot break stone with current tools. [food ${17 - (i % 3)}/20 health 20/20]`);
            output.push(`Still ${i} blocks from ${-100 - i}, ${70 + (i % 5)}, ${40 + i} at 12:${String(i % 60).padStart(2, '0')}:${String((i * 3) % 60).padStart(2, '0')}`);
            output.push('INVENTORY FULL DETECTED: 0 empty slots, 1043 total items');
        }
        const behavior = [
            ...Array(20).fill('Pathfinding stopped: Cannot break stone with current tools.'),
            'self_preservation: left the lava',
        ].join('\n');
        const cut = 'timed out: ran past the 5-minute action limit while travelling';
        const critique = `the attempt was ${cut}; it did not finish`;
        const invFull = 'Inventory is full (0 empty slots, 1043 total items). Gained +0 stripped_birch_wood (needed 1). Largest stacks: cobblestone: 640';
        const raw = `Attempt ${cut}\nExecution output:\n${output.join('\n')}\n${trace.map(r => `${r.name}(${r.args}) -> ${r.ret}`).join('\n')}\nCritic: ${critique}\nInventory fact: ${invFull}\nChat/behaviour log: ${behavior}`;
        const feedback = codeRetryFeedback({ cut, output: output.join('\n'), trace, critique, invFull, behaviorLog: behavior });

        assert.ok(feedback.includes('collectLogs(4,"birch_log")'));
        assert.ok(feedback.includes('(x60)'));
        assert.ok(feedback.includes('FAILED: cannot reach birch_log'));
        assert.ok(feedback.includes('Cannot break stone'));
        const tracePart = feedback.split('Execution output:')[0];
        const afterTrace = feedback.slice(tracePart.length);
        assert.ok(tracePart.includes('Cannot break stone'));
        // The output line is not the trace line: the food number differs, so it is kept.
        assert.ok(afterTrace.includes('Cannot break stone'));
        assert.ok(feedback.includes('birch_log'));
        assert.ok(feedback.includes('equipBestTool'));
        assert.ok(feedback.includes('mineBlock'));
        assert.ok(feedback.includes('goToPosition'));
        assert.ok(feedback.includes(cut));
        assert.ok(feedback.includes('5-minute'));
        assert.ok(feedback.includes(critique));
        assert.ok(feedback.includes('0 empty slots'));
        assert.ok(feedback.includes('1043'));
        // The output sentence and the inventory fact are different sentences. Both stay.
        assert.strictEqual(feedback.split('1043').length - 1, 2);
        assert.ok(feedback.includes('stripped_birch_wood'));
        assert.ok(feedback.includes('self_preservation: left the lava'));
        assert.ok(feedback.includes('-100,'), feedback);
        assert.ok(feedback.includes('-300,'), feedback);
        assert.ok(feedback.includes('-499,'), feedback);
        const traceSection = feedback.split('Execution output:')[0];
        let calls = 0;
        for (const line of traceSection.split('\n')) {
            if (!line.includes('->')) continue;
            const m = line.match(/\(x(\d+)\)/);
            calls += m ? Number(m[1]) : 1;
        }
        assert.strictEqual(calls, 789);
        const traceLines = structuredTrace(trace).split('\n');
        assert.ok(traceLines.some(l => l.includes('collectLogs(4,"birch_log")') && l.includes('(x60)')));
        assert.ok(traceLines.filter(l => l.includes('goToPosition')).length > 1);

        const system = 's'.repeat(CODE_RETRY_78.systemMessageChars);
        const user = `Task: ${CODE_RETRY_78.task}\n--- feedback from last attempt ---\n${feedback}\n`;
        const rawUser = `Task: ${CODE_RETRY_78.task}\n--- feedback from last attempt ---\n${raw}\n`;
        const fitted = tokensOf(system, user);
        const unfitted = tokensOf(system, rawUser);
        const overflowMargin = unfitted.tokens - NUM_CTX;
        assert.ok(overflowMargin > 0, `the uncollapsed retry was ${unfitted.tokens} tokens, ${overflowMargin} over num_ctx ${NUM_CTX}`);
        // Identical lines collapse. Lines that differ, including by a coordinate, stay. This shape's distinct lines are still over num_ctx.
        assert.ok(fitted.tokens < unfitted.tokens, `grouped ${fitted.tokens} tokens, raw ${unfitted.tokens}, feedback ${feedback.length} chars`);
        assert.ok(feedback.includes('Still 200 blocks from -300,'));
    });

    it('the compose-retry prompt is dumped before the code model is called, including when the call throws', async () => {
        writeCodePromptDump('system-marker', 'user-marker');
        assert.match(readFileSync(CODE_PROMPT_DUMP, 'utf8'), /SYSTEM:\nsystem-marker\n\nUSER:\nuser-marker\n/);
        const { Voyager } = await import('../src/agent/voyager.js');
        const v = Object.create(Voyager.prototype);
        let dumpedDuringSend = '';
        v.agent = { prompter: { code_model: { sendRequest: async () => { dumpedDuringSend = readFileSync(CODE_PROMPT_DUMP, 'utf8'); throw new Error(`request (${CODE_RETRY_78.promptTokens} tokens) exceeds the available context size (${CODE_RETRY_78.contextTokens} tokens)`); } } } };
        v._overlapCpuMaintenance = () => {};
        v._ensureInferCover = () => ({ enter() {}, async leave() {} });
        const system = 'SYSTEM-OVERFLOW';
        const user = 'USER-OVERFLOW collectLogs birch_log';
        await assert.rejects(() => v._ask(system, user, { kind: 'compose-retry', components: { system: system.length, user: user.length } }), new RegExp(`${CODE_RETRY_78.promptTokens} tokens`));
        assert.match(dumpedDuringSend, /SYSTEM-OVERFLOW/);
        assert.match(dumpedDuringSend, /USER-OVERFLOW collectLogs birch_log/);
        assert.match(readFileSync(CODE_PROMPT_DUMP, 'utf8'), /USER-OVERFLOW collectLogs birch_log/);
        assert.throws(() => writeCodePromptDump('system-only'), /user prompt must be text/);
        assert.throws(() => writeCodePromptDump('system-only', undefined), /undefined/);
    });

    it('three errors on one call keep the middle one', () => {
        const one = [record('craftItem', '["crafting_table",1]', false, ['no wood', 'no crafting table within reach', 'no planks'])];
        const text = structuredTrace(one);
        assert.ok(text.includes('no wood'));
        assert.ok(text.includes('no crafting table within reach'));
        assert.ok(text.includes('no planks'));
        const three = [
            record('craftItem', '["crafting_table",1]', false, ['no wood']),
            record('craftItem', '["crafting_table",1]', false, ['no crafting table within reach']),
            record('craftItem', '["crafting_table",1]', false, ['no planks']),
        ];
        const listed = structuredTrace(three);
        assert.ok(listed.includes('no crafting table within reach'));
        assert.strictEqual(listed.split('\n').length, 3);
    });

    it('return values 0, 3, 0 stay two outcomes', () => {
        const trace = [
            record('mineBlock', '["stone"]', false, [], -1, 0),
            record('mineBlock', '["stone"]', false, [], -1, 3),
            record('mineBlock', '["stone"]', false, [], -1, 0),
        ];
        const text = structuredTrace(trace);
        assert.ok(text.includes('-> 0 FAIL (x2)'));
        assert.ok(text.includes('-> 3 FAIL'));
        assert.ok(!text.includes('-> 0 FAIL (x3)'));
        assert.ok(!text.includes('-> 0 (x3)'));
    });

    it('gained counts +0, +4, +0 stay two values', () => {
        const output = ['Gained +0 oak_log', 'Gained +4 oak_log', 'Gained +0 oak_log'].join('\n');
        const feedback = codeRetryFeedback({ cut: null, output, trace: [], critique: '', invFull: null, behaviorLog: '' });
        assert.ok(feedback.includes('Gained +0 oak_log (x2)'));
        assert.ok(feedback.includes('Gained +4 oak_log'));
        assert.ok(!feedback.includes('Gained +0 oak_log (x3)'));
        assert.ok(!feedback.includes('+0 (x3)'));
    });

    it('a longer line is not dropped because a shorter line is its prefix', () => {
        const trace = [record('finish', '[]', true, ['Done'])];
        const feedback = codeRetryFeedback({
            cut: null,
            output: 'Done with errors: creeper exploded',
            trace,
            critique: '',
            invFull: null,
            behaviorLog: '',
        });
        assert.ok(feedback.includes('Done'));
        assert.ok(feedback.includes('Done with errors: creeper exploded'));
    });
});
