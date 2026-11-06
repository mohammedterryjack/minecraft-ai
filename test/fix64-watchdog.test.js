/**
 * fix64 regressions (live 2026-11-06: icefox2000 offline 12:44:12Z-13:04:06Z, process never exited).
 * 1) The trial candidate of collectBlock (task "repair: Mine 1 iron_ore") retried with `excluded.add(..); i--; continue;`
 *    after a fresh getNearestBlocks(.., 64, 10000) scan, on a path with no await. It called the RELATIVE
 *    getBlockAtPosition(bot, dx, dy, dz) with absolute coordinates, so every candidate read as missing and the loop ran
 *    one full scan per candidate without yielding: keep_alive unanswered, server "Timed out", log frozen. The fix44 guard
 *    injected into each loop (`if (bot.interrupt_code) return`) can never fire there, because the flag is set from an event
 *    handler. Staging now starts every iteration of an async loop with one event-loop turn.
 * 2) The #44 stall guard and the exit-on-disconnect handlers are main-loop callbacks, so a blocked loop silenced them.
 *    A worker-thread watchdog (Atomics heartbeat, limit = learned keep_alive gap + beat period) SIGKILLs a blocked process
 *    after writing the last phase/skill evidence from the worker.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { Coder } from '../src/agent/coder.js';

const NAME = '__fix64_test__';
after(() => { rmSync(`./bots/${NAME}`, { recursive: true, force: true }); rmSync(`./bots/${NAME}-watchdog_kill.json`, { force: true }); });

// Verbatim from bots/icefox2000/skills/index.json on the iMac: collectBlock.candidate.code (under trial since 09:37Z,
// staged into "Mine 5 iron_ore" attempt 4 by fix24's "candidates get trial runs in every task"; its line
// `for (const b of candidates)` is the one the 12:43:41Z lint warning quoted as Line 92).
const LIVE_CANDIDATE = `async function collectBlock(bot, blockType, num = 1) {
    if (!blockType || typeof blockType !== 'string') { log(bot, 'FAILED: invalid blockType'); return false; }
    let types = [blockType];
    if (['coal', 'diamond', 'emerald', 'iron', 'gold', 'lapis_lazuli', 'redstone', 'copper'].includes(blockType)) types.push(blockType + '_ore');
    if (blockType.endsWith('ore')) types.push('deepslate_' + blockType);
    if (blockType === 'dirt') types.push('grass_block');
    if (blockType === 'cobblestone') types.push('stone');
    types = [...new Set(types)];
    let collected = 0;
    const excluded = new Set();
    const posKey = (p) => \`\${Math.floor(p.x)},\${Math.floor(p.y)},\${Math.floor(p.z)}\`;
    for (let i = 0; i < num; i++) {
        if (bot.interrupt_code) { log(bot, 'FAILED: interrupted'); return false; }
        let candidates = getNearestBlocks(bot, types, 64, 10000);
        if (!candidates || !candidates.length) { log(bot, \`FAILED: no \${blockType} in range\`); return false; }
        let block = null;
        for (const b of candidates) {
            if (!b || !b.position) continue;
            if (excluded.has(posKey(b.position))) continue;
            block = b;
            break;
        }
        if (!block) { log(bot, \`FAILED: only excluded or invalid \${blockType} candidates remain\`); return false; }
        const here = getBlockAtPosition(bot, Math.floor(block.position.x), Math.floor(block.position.y), Math.floor(block.position.z));
        if (!here || !types.includes(here.name)) { excluded.add(posKey(block.position)); log(bot, \`FAILED: target block missing at \${posKey(block.position)}\`); i--; continue; }
        block = here;
        await bot.tool.equipForBlock(block);
        collected++;
    }
    return collected;
}`;

// The block-name -> id lookup in getNearestBlocks needs a logged-in bot's registry; getNearestBlocksWhere is the same scan
// (bot.findBlocks + bot.blockAt) without it, and the mock findBlocks below already returns only ore positions.
const RUNNABLE_CANDIDATE = LIVE_CANDIDATE.replace('getNearestBlocks(bot, types, 64, 10000)', 'getNearestBlocksWhere(bot, types, 64, 10000)');
assert.notStrictEqual(RUNNABLE_CANDIDATE, LIVE_CANDIDATE);

/** A world with `ores` iron_ore blocks; the bot stands elsewhere, so bot-relative lookups at absolute coords miss. */
function oreWorld(ores) {
    const at = new Map();
    for (let k = 0; k < ores; k++) { const p = new Vec3(10 + k, 12, 10); at.set(p.toString(), { name: 'iron_ore', type: 1, position: p }); }
    const bot = {
        output: '', interrupt_code: false, scans: 0,
        entity: { position: new Vec3(-122, 33, 58) },
        registry: {},
        findBlocks() { bot.scans++; return [...at.values()].map(b => b.position); },
        blockAt(p) { return at.get(p.floored().toString()) ?? null; },
    };
    return bot;
}

async function coder() {
    const c = new Coder({ name: NAME });
    while (!c.code_lint_template || !c.code_template) await new Promise(r => setImmediate(r));
    return c;
}

/** Counts event-loop turns while `run` is pending. */
async function turnsDuring(run) {
    let turns = 0, done = false;
    const tick = () => { if (done) return; turns++; setImmediate(tick); };
    setImmediate(tick);
    const r = await run();
    done = true;
    return { r, turns };
}

// the world.getBlockAtPosition the live candidate ran against (12:44Z): offsets RELATIVE to the feet, unloaded read as air.
// fix65 made unloaded null, fix67 removed the three-number form (getBlockAtOffset / getBlockAtAbsolute take one Vec3).
const LIVE_GET_BLOCK_AT_POSITION = (bot, x = 0, y = 0, z = 0) => bot.blockAt(bot.entity.position.offset(x, y, z)) ?? { name: 'air' };

describe('fix64: async loops yield every iteration', () => {
    it('the live collectBlock candidate, run as written, never yields: one full scan per ore and zero event-loop turns', async () => {
        const world = await import('../src/agent/library/world.js');
        const skills = await import('../src/agent/library/skills.js');
        const fn = new Function('getNearestBlocksWhere', 'getBlockAtPosition', 'log', `return (${RUNNABLE_CANDIDATE});`)(world.getNearestBlocksWhere, LIVE_GET_BLOCK_AT_POSITION, skills.log);
        const ores = 40;
        const bot = oreWorld(ores);
        const { r, turns } = await turnsDuring(() => fn(bot, 'iron_ore', 5));
        assert.strictEqual(r, false);
        assert.strictEqual(bot.scans, ores + 1, 'every exclusion re-ran the 64-block scan');
        assert.strictEqual(turns, 0, 'nothing else (keep_alive, interrupts, stall guard) ran while it looped');
        assert.match(bot.output, /only excluded or invalid iron_ore candidates remain/);
    });

    it('the same candidate staged for exec yields once per iteration, so the loop no longer holds the event loop', async () => {
        const c = await coder();
        const staged = await c._stageCode(`const getBlockAtPosition = ${LIVE_GET_BLOCK_AT_POSITION};\n${RUNNABLE_CANDIDATE}\nawait collectBlock(bot, 'iron_ore', 5);`, { lintOnly: false });   // fix67: the API it ran against
        const ores = 40;
        const bot = oreWorld(ores);
        const { turns } = await turnsDuring(() => staged.func.main(bot));
        assert.strictEqual(bot.scans, ores + 1);
        assert.ok(turns >= ores, `event loop turned ${turns} times during ${ores + 1} scans`);
    });

    it('an unbounded async loop with no await on its path is now stopped by an interrupt raised from the event loop', { timeout: 20000 }, async () => {
        const c = await coder();
        const staged = await c._stageCode(`async function spin(bot) {\n    for (;;) {\n        bot.iters++;\n        continue;\n    }\n}\nawait spin(bot);`, { lintOnly: false });
        const bot = { output: '', interrupt_code: false, iters: 0 };
        let turns = 0;
        const raise = () => { if (++turns === 5) bot.interrupt_code = true; else setImmediate(raise); };
        setImmediate(raise);
        await staged.func.main(bot);
        assert.ok(bot.iters >= 1 && bot.iters <= 5, `looped ${bot.iters} times before the interrupt`);
        assert.match(bot.output, /Code interrupted/);
    });

    it('turns go into every async loop form, keep line numbers, and skip loops in non-async functions', async () => {
        const c = await coder();
        const src = [
            'async function a(bot) {',
            '    while (x) y();',
            '    do { z(); } while (q);',
            '    for (const k of ks) {',
            '    }',
            '    const f = (n) => { for (let i = 0; i < n; i++) {} };',
            '}',
        ].join('\n');
        const out = c._injectLoopTurns(src);
        assert.strictEqual(out.split('\n').length, src.split('\n').length);
        const lines = out.split('\n');
        assert.match(lines[1], /while \(x\) \{ await __loopTurn__\(\); y\(\); \}/);
        assert.match(lines[2], /do \{ await __loopTurn__\(\); z\(\); \}/);
        assert.match(lines[3], /for \(const k of ks\) \{ await __loopTurn__\(\);/);
        assert.doesNotMatch(lines[5], /__loopTurn__/, 'a sync arrow cannot await');
    });

    it('lint feedback names only loops that cannot yield (inside non-async functions)', async () => {
        const c = await coder();
        const src = 'async function a(bot) {\n    for (const b of cs) { if (b) break; }\n    const g = () => { while (true) {} };\n}';
        const w = c._syncLoopLint(src, 0);
        assert.deepStrictEqual(w.map(x => x.line), [3]);
    });
});

const CHILD = fileURLToPath(new URL('./fixtures/fix64-watchdog-child.mjs', import.meta.url));
function runChild(mode, gapMs) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [CHILD, mode, String(gapMs), `./bots/${NAME}-watchdog_kill.json`, 'mineIron > collectBlock'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { err += d; });
        p.on('exit', (code, signal) => resolve({ code, signal, out, err }));
    });
}

describe('fix64: off-main-thread watchdog', () => {
    it('a child whose main thread spins forever is SIGKILLed by the worker, with phase/skill evidence on stderr', { timeout: 30000 }, async () => {
        const r = await runChild('spin', 200);
        assert.strictEqual(r.signal, 'SIGKILL', `child ended code=${r.code} signal=${r.signal}\n${r.err}`);
        assert.match(r.out, /\[watchdog\] ARMED: SIGKILL after \d+ms without a main-loop heartbeat/);
        assert.match(r.err, /\[watchdog\] MAIN THREAD BLOCKED/);
        assert.match(r.err, /phase_stack="fixture:voyager:exec"/);
        assert.match(r.err, /skill="spinForever"/);
        assert.match(r.err, /stack="mineIron > collectBlock"/);
    });

    it('a healthy child that keeps beating is never killed and exits normally', { timeout: 30000 }, async () => {
        const r = await runChild('healthy', 200);
        assert.strictEqual(r.signal, null, r.err);
        assert.strictEqual(r.code, 0, r.err);
        assert.doesNotMatch(r.err, /MAIN THREAD BLOCKED|LOUD FAIL/);
    });
});
