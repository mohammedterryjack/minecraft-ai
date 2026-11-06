#!/usr/bin/env node
/**
 * Measures wall time and max event-loop delay during staging, lint, and exec-stage (includes SES eval).
 * Bundle: ~95 tiny async skills + instrumentSrc wrapper (sized ~110k chars).
 *
 * Run: node scripts/measure-staging-event-loop.js
 */
import { mkdirSync, writeFileSync } from 'fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setSettings } from '../src/agent/settings.js';
import rootSettings from '../settings.js';
import { instrumentSrc } from '../src/agent/skill_graph.js';
import { Coder, collectBareApiUsedInSource } from '../src/agent/coder.js';
import { withStallPhase } from '../src/utils/event_loop_guard.js';

setSettings({
    check_timeout_interval_ms: rootSettings.check_timeout_interval_ms,
    event_loop_stall_poll_interval_ms: rootSettings.event_loop_stall_poll_interval_ms,
    world_scan_stall_warn_distance: rootSettings.world_scan_stall_warn_distance,
});

const TARGET_CHARS = 110000;

function buildSyntheticLibrary(skillCount) {
    const parts = [];
    for (let i = 0; i < skillCount; i++) {
        parts.push(`async function measureSkill${i}(bot) { log(bot, 'm${i}'); }`);
    }
    return parts.join('\n');
}

function buildEntry(names) {
    if (!names.length) throw new Error('measure: empty skill name list');
    return `async function measureEntry(bot) { await ${names[0]}(bot); }\nawait measureEntry(bot);`;
}

function buildFullBundle() {
    let lib = buildSyntheticLibrary(95);
    const names = [];
    for (let i = 0; i < 95; i++) names.push(`measureSkill${i}`);
    const traced = [...names, 'measureEntry'];
    let full = lib + '\n\n' + instrumentSrc(traced) + '\n\n' + buildEntry(names);
    while (full.length < TARGET_CHARS) {
        lib += '\n' + buildSyntheticLibrary(50);
        full = lib + '\n\n' + instrumentSrc(traced) + '\n\n' + buildEntry(names);
    }
    return full;
}

async function main() {
    const dir = './bots/__measure_staging__';
    mkdirSync(`${dir}/action-code`, { recursive: true });
    writeFileSync(`${dir}/.keep`, '');

    const agent = {
        name: '__measure_staging__',
        bot: { interrupt_code: false },
        voyager: { skills: [] },
    };
    const coder = new Coder(agent);
    await new Promise((r) => setTimeout(r, 200));
    if (!coder.code_template || !coder.code_lint_template) throw new Error('coder templates not loaded');

    const full = buildFullBundle();
    const learnedNames = new Set(String(full).match(/\bmeasureSkill\d+\b/g) || []);
    learnedNames.add('measureEntry');

    const bareApiFilter = collectBareApiUsedInSource(full);
    const stageOpts = { bareApiFilter, learnedNamesForLint: learnedNames };

    const hist = monitorEventLoopDelay({ resolution: 20 });
    hist.enable();

    async function measure(label, fn) {
        hist.reset();
        const t0 = Date.now();
        await withStallPhase(label, fn);
        return { label, maxEventLoopDelayMs: hist.max / 1e6, wallMs: Date.now() - t0 };
    }

    const timings = [];
    timings.push(await measure('measure:stage-lint', () => coder._stageCode(full, { ...stageOpts, lintOnly: true })));
    const lintBundle = await coder._stageCode(full, { ...stageOpts, lintOnly: true });
    if (typeof lintBundle.preludeLines !== 'number') throw new Error('measure: preludeLines must be a number');
    timings.push(await measure('measure:lint', () => coder._lintCode(lintBundle.src_lint_copy, lintBundle.preludeLines)));
    timings.push(await measure('measure:stage-exec', () => coder._stageCode(full, { ...stageOpts, lintOnly: false })));

    hist.disable();

    const max = (arr) => Math.max(...arr.map((x) => x.maxEventLoopDelayMs));
    const report = {
        wrappedSkillCount: learnedNames.size - 1,
        bundleChars: full.length,
        bundleLines: full.split('\n').length,
        phases: timings,
        maxEventLoopDelayMs: max(timings),
    };
    console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
