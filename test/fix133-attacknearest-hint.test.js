/**
 * fix133 (live icefox2000, 16 Nov 2026 19:3x GMT): "Obtain 1 spider_eye" failed 4/4 attempts
 * with `attackNearest("spider",true) -> false FAIL` and no reason in the evidence. attackNearest
 * did log habitat guidance (fix127), but annotateTrace keeps only lines matching FAIL_LINE
 * (/FAILED|\bfailed\b|.../, skill_graph.js:528) — and the hint matched none of it, so the critic
 * and the PSN repair prompts saw a bare false and re-emitted the same 24-block glance every
 * attempt. The guidance now carries the FAILED prefix the trace annotator promotes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import { attackNearest } from '../src/agent/library/skills.js';
import { annotateTrace } from '../src/agent/skill_graph.js';

const registry = Registry('1.20.4');

describe('fix133 attackNearest failure guidance survives the trace annotator', () => {
    it('the no-mob line is promoted into ownFail and carries the goToMob hint', async () => {
        const bot = Object.assign(new EventEmitter(), {
            registry,
            output: '',
            interrupt_code: false,
            modes: { pause() {}, isOn: () => false },
            entity: { position: new Vec3(0, 33, 0) },
            entities: {},
        });
        assert.strictEqual(await attackNearest(bot, 'spider', true), false);
        const trace = annotateTrace([{ name: 'obtainSpiderEye', depth: 0, parent: -1, o0: 0, o1: bot.output.length, args: [], ret: 'false' }], bot.output);
        assert.ok(trace[0].ownFail.length >= 1, `ownFail empty; output was: ${bot.output}`);
        assert.match(trace[0].ownFail.join('\n'), /goToMob\(bot, "spider"\)/);
    });
});
