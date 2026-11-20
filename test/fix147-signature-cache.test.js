import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signatureOf, signatureOfStats } from '../src/agent/skill_graph.js';

// fix147 (20 Nov crash loop): replay routing (_lexicalReplay/_embedReplay/_polyMerge) called signatureOf for
// every skill on every routing pass, acorn-parsing ~1 MB of skill code per pass; _polyMerge did one full parse
// per skill (>4 min sync) so the 30 s watchdog SIGKILLed and the socket ping-timed out every ~minute
// (launchd runs 1039->1185). Signature parsing is pure over (code, name) and is now memoised per name, keyed
// by the exact code string, recomputed when the code changes (rewriteCode) and never on parse failure.

test('signatureOf is memoised for repeated identical code', () => {
    const code = `async function memoProbe(bot, count = 3) { await bot.collectBlock.collect(bot.registry.itemsByName.dirt, 5); }`;
    const before = signatureOfStats();
    assert.equal(signatureOf(code, 'memoProbe'), 'memoProbe(bot, count = 3)');
    const afterFirst = signatureOfStats();
    assert.equal(afterFirst.parses - before.parses, 1);
    const s2 = signatureOf(code, 'memoProbe');
    const afterSecond = signatureOfStats();
    assert.equal(s2, 'memoProbe(bot, count = 3)');
    assert.equal(afterSecond.parses, afterFirst.parses, 'second call on identical code must not re-parse');
    assert.ok(afterSecond.hits > afterFirst.hits);
});

test('signatureOf recomputes when the skill code changes', () => {
    assert.equal(signatureOf('function evolveProbe(a) {}', 'evolveProbe'), 'evolveProbe(a)');
    assert.equal(signatureOf('function evolveProbe(a, b, c = 1) {}', 'evolveProbe'), 'evolveProbe(a, b, c = 1)');
    assert.equal(signatureOf('function evolveProbe(a, b, c = 1) {}', 'evolveProbe'), 'evolveProbe(a, b, c = 1)');
});

test('signatureOf parse failures stay loud on every call (never cached)', () => {
    assert.throws(() => signatureOf('function broken( {{{', 'broken'), /signatureOf/);
    assert.throws(() => signatureOf('function broken( {{{', 'broken'), /signatureOf/);
});

test('History.save survives agent.task being null (boot-time cleanKill)', async () => {
    const { History } = await import('../src/agent/history.js');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix147-'));
    const agent = {
        name: 'fix147_scratch',
        task: null,
        last_sender: null,
        self_prompter: { state: {}, isStopped: () => true, prompt: null },
    };
    const h = new History(agent);
    h.memory_fp = path.join(dir, 'memory.json'); // History derives bots/<name>/memory.json from cwd; keep it in tmp
    await h.save(); // threw TypeError before fix147 (taskStart read off null task) and save() rethrew -> exit 1
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'));
    assert.equal(data.taskStart, null);
    fs.rmSync(`./bots/fix147_scratch`, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
});
