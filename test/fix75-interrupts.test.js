// fix75: every interrupt records its source where it fires; a timeout is a failed attempt of kind 'timeout'; a step throw
// no longer backs the loop off.
//
// Live (iMac logs/mindcraft.log, 2026-11-06, UTC):
//   14:07:21Z and 14:10:10Z: an attempt cut off by the idle-practice abort (bot.interrupt_code set directly, "[idle-practice]
//   ABORTED ensureFurnaceWithinSixteen" printed during the attempt, attempts took 3266 ms and 523 ms) -> "step failed:
//   _interruptReason called but no interrupt source (lastInterruptBy missing)", then "next step in 100s" / "133s".
//   14:25:37Z: "Code execution timed out after 5 minutes" on 'Mine 1 diamond_ore' (attempt took 300280 ms) -> the same
//   throw -> "1 failing step(s) in a row; next step in 728s". 14:28Z: "icefox2000 was slain by Red Figure" at
//   (-161.30, 7.00, -15.46) with no step running; the next step started at 14:37:45Z (gap 728280 ms).
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { ActionManager, checkInterruptSource } from '../src/agent/action_manager.js';
import { setBotApiDurationStore } from '../src/utils/bot_api_timing.js';

let Voyager, stepErrorSignature;
before(async () => { const mod = await import('../src/agent/voyager.js'); Voyager = mod.Voyager; stepErrorSignature = mod.stepErrorSignature; mod._setVersionForTest('1.21.4'); });

/** An agent as far as ActionManager uses it; requestInterrupt is agent.js's (checked against the source below). */
function mkAgent() {
    // A finished action calls bot.emit through the timing proxy. That call is compared with
    // recorded durations of emit. Voyager attaches progress.botApiDurations; this agent has no
    // progress, so the test attaches the same empty store.
    setBotApiDurationStore({});
    const agent = {
        bot: { interrupt_code: false, output: '', emit() {}, stopDigging() {}, collectBlock: { cancelTask() {} }, pathfinder: { stop() {}, setGoal() {} }, pvp: { stop() {} } },
        history: { add() {} }, cleanKill(m) { throw new Error('cleanKill: ' + m); },
        clearBotLogs() { this.bot.output = ''; this.bot.interrupt_code = false; },
        requestInterrupt(source) { this.actions.noteInterrupt(source); this.bot.interrupt_code = true; },
        isIdle() { return !this.actions.executing; }, self_prompter: { isActive: () => false },
    };
    agent.actions = new ActionManager(agent);
    return agent;
}
/** Generated code: works until interrupted, then returns (as the compartment's interrupt checks do). */
const untilInterrupted = (agent) => async () => { while (!agent.bot.interrupt_code) await new Promise(r => setTimeout(r, 5)); };

describe('fix75: every interrupt source records itself', () => {
    it('the action timeout (live 14:25:37Z) records { kind: timeout } and timedout on the cut action', async () => {
        const agent = mkAgent();
        const res = await agent.actions.runAction('voyager:Mine 1 diamond_ore', untilInterrupted(agent), { timeout: 0.001 });
        assert.strictEqual(res.interrupted, true);
        assert.strictEqual(res.timedout, true);
        assert.deepStrictEqual(res.interruptedBy, { kind: 'timeout', by: '0.001-minute action limit' });
    });
    it('a mode pre-empting an action is recorded on the pre-empted action', async () => {
        const agent = mkAgent();
        const p = agent.actions.runAction('voyager:Mine 1 iron_ore', untilInterrupted(agent), { timeout: -1 });
        await new Promise(r => setTimeout(r, 20));
        const mode = await agent.actions.runAction('mode:self_defense', async () => {}, { timeout: -1 });
        const res = await p;
        assert.deepStrictEqual(res.interruptedBy, { kind: 'preempt', by: 'mode:self_defense' });
        assert.strictEqual(res.timedout, false);
        assert.strictEqual(mode.interruptedBy, null, 'the mode action itself was not interrupted');
    });
    it('the first source of an action wins; the next action starts with none and timedout reset', async () => {
        const agent = mkAgent();
        const p = agent.actions.runAction('voyager:x', untilInterrupted(agent), { timeout: 0.001 });
        await new Promise(r => setTimeout(r, 20));
        agent.requestInterrupt({ kind: 'stall', by: 'no progress' });
        const res = await p;
        assert.deepStrictEqual(res.interruptedBy, { kind: 'stall', by: 'no progress' });
        await new Promise(r => setTimeout(r, 100));   // the timer (if it was not cleared) would fire here
        const next = await agent.actions.runAction('voyager:y', async () => {}, { timeout: -1 });
        assert.deepStrictEqual([next.interrupted, next.timedout, next.interruptedBy], [false, false, null]);
    });
    it('after a timeout, the next action no longer reports timedout (this.timedout was never reset, 8d5c995)', async () => {
        const agent = mkAgent();
        await agent.actions.runAction('voyager:a', untilInterrupted(agent), { timeout: 0.001 });
        const next = await agent.actions.runAction('voyager:b', async () => {}, { timeout: -1 });
        assert.strictEqual(next.timedout, false);
    });
    it('live 14:07:21Z / 14:10:10Z: a raw interrupt_code write (the pre-fix70 idle-practice abort) leaves no source, and that is loud', async () => {
        // since fix70 (#65) _ask waits for the practice run to end before the attempt starts, so this write can no longer land
        // in an action; if any code does it again, the result says interruptedBy null and _interruptReason throws (below)
        const agent = mkAgent();
        const p = agent.actions.runAction('voyager:Ensure a furnace', untilInterrupted(agent), { timeout: -1 });
        await new Promise(r => setTimeout(r, 20));
        agent.bot.interrupt_code = true;
        const res = await p;
        assert.deepStrictEqual([res.interrupted, res.interruptedBy], [true, null]);
    });
    it('an interrupt or stop without a source throws', async () => {
        assert.throws(() => checkInterruptSource(undefined), /interrupt without a source/);
        assert.throws(() => checkInterruptSource({ kind: 'mode' }), /interrupt without a source/);
        const agent = mkAgent();
        await assert.rejects(agent.actions.stop(), /interrupt without a source/);
    });
    it('no call site interrupts or stops without naming its source', () => {
        const files = ['src/agent/agent.js', 'src/agent/modes.js', 'src/agent/self_prompter.js', 'src/agent/voyager.js', 'src/agent/action_manager.js', ...readdirSync('src/agent/commands').map(f => `src/agent/commands/${f}`)];
        for (const f of files) {
            const src = readFileSync(f, 'utf8');
            assert.doesNotMatch(src, /requestInterrupt\(\)/, f);
            assert.doesNotMatch(src, /actions\.stop\(\)/, f);
            assert.doesNotMatch(src, /\.lastInterruptBy|lastInterruptBy\s*=/, f);
        }
        const agentSrc = readFileSync('src/agent/agent.js', 'utf8');
        assert.match(agentSrc, /requestInterrupt\(source\) \{\n\s+this\.actions\.noteInterrupt\(source\);\n\s+this\.bot\.interrupt_code = true;/, 'mkAgent mirrors agent.js');
    });
});

describe('fix75: _interruptReason reads the recorded source', () => {
    const mkV = () => { const v = Object.create(Voyager.prototype); v.agent = { bot: { entity: { position: { x: -161.3, y: 7, z: -15.46 } } } }; v._diedInRun = () => null; v._stalledInRun = () => null; v._surfaceY = () => 64; return v; };
    it('a timeout is a failed attempt of kind timeout (live 14:25:37Z threw "lastInterruptBy missing")', () => {
        const v = mkV();
        const why = v._interruptReason({ message: 'Action output:\n', interrupted: true, timedout: true, interruptedBy: { kind: 'timeout', by: '5-minute action limit' } });
        assert.strictEqual(v._lastCutKind, 'timeout');
        assert.match(why, /^timed out: ran past the 5-minute action limit \(underground: y=7, surface y=64\)$/);
    });
    it('a mode or pre-emption is an interrupt naming its source; unstuck is "stuck"', () => {
        const v = mkV();
        assert.match(v._interruptReason({ message: '', interrupted: true, timedout: false, interruptedBy: { kind: 'preempt', by: 'mode:self_defense' } }), /^interrupted: cut off by preempt mode:self_defense/);
        assert.strictEqual(v._lastCutKind, 'interrupt');
        assert.match(v._interruptReason({ message: '', interrupted: true, timedout: false, interruptedBy: { kind: 'preempt', by: 'mode:unstuck' } }), /^interrupted: stuck/);
    });
    it('an interrupt nobody recorded still fails loud, naming the rule', () => {
        assert.throws(() => mkV()._interruptReason({ message: '', interrupted: true, timedout: false, interruptedBy: null }), /no source recorded itself/);
    });
    it('a timeout source on a result that did not time out is a contradiction: throw', () => {
        assert.throws(() => mkV()._interruptReason({ message: '', interrupted: true, timedout: false, interruptedBy: { kind: 'timeout', by: '5-minute action limit' } }), /timedout=false/);
    });
});

describe('fix75: a step throw does not back the loop off', () => {
    function mkLoop(errors) {
        const v = Object.create(Voyager.prototype);
        const fatal = []; let steps = 0;
        Object.assign(v, {
            progress: { enabled: true }, running: false, lastPlayerMsg: 0, _lastStepErrSig: null, _sample() {},
            idlePractice: { markBusy() {}, markIdle() {} },
            agent: { isIdle: () => true, self_prompter: { isActive: () => false }, prompter: { awaiting_coding: false }, fatal: (w, e) => fatal.push([w, e]) },
            step: async () => { const e = errors[steps++]; if (e) throw e; },
        });
        const tick = async () => { v.update(); await new Promise(r => setImmediate(r)); };
        return { v, fatal, tick, steps: () => steps };
    }
    const liveErr = () => { try { throw new Error('_interruptReason called but no interrupt source (lastInterruptBy missing)'); } catch (e) { return e; } };
    it('the step after a failed step starts on the next update() (was: 728 s of no steps after the 14:25:37Z failure)', async () => {
        const L = mkLoop([liveErr(), null]);
        await L.tick(); await L.tick();
        assert.strictEqual(L.steps(), 2);
        assert.deepStrictEqual(L.fatal, []);
        assert.ok(!('_backoffUntil' in L.v) && !('_errStreak' in L.v));
    });
    it('the same error signature on two consecutive steps is fatal (launchd restarts visibly)', async () => {
        const L = mkLoop([liveErr(), liveErr()]);
        await L.tick(); await L.tick();
        assert.strictEqual(L.fatal.length, 1);
        assert.match(L.fatal[0][0], /the same step error on two consecutive steps \(Error: _interruptReason called but no interrupt source/);
    });
    it('a different error, or a clean step in between, is not a repeat', async () => {
        const L = mkLoop([liveErr(), new Error('something else'), null, liveErr()]);
        for (let i = 0; i < 4; i++) await L.tick();
        assert.strictEqual(L.steps(), 4);
        assert.deepStrictEqual(L.fatal, []);
    });
    it('the signature is the class, message and raising frame', () => {
        const a = liveErr(), b = liveErr();
        assert.strictEqual(stepErrorSignature(a), stepErrorSignature(b));
        assert.match(stepErrorSignature(a), /^Error: _interruptReason .* @ at liveErr /);
        assert.strictEqual(stepErrorSignature('boom'), 'non-Error string: boom');
    });
});
