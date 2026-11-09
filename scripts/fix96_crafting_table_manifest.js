#!/usr/bin/env node
/**
 * fix96: build the reset manifest for outcomes learned while the seeded ensureCraftingTable read only the FIRST
 * crafting_table recipe (oak_planks) and failed "needs N more oak_planks but cannot craft it (no 2x2 recipe ...)" while
 * the bot held other planks/wood it could have used. Every goalStats outcome and goalFailStates row with that exact
 * failure text is bug-learned. The counts move while the bot runs, so the manifest is built from the file on disk at
 * reset time (stop the bot first), not hand-copied.
 *
 *   node scripts/fix96_crafting_table_manifest.js --bots-dir=bots/icefox2000 > fix96_manifest.json
 *   node scripts/reset_bug_poisoned.js --manifest=fix96_manifest.json --bots-dir=bots/icefox2000           # dry-run
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

// the text the pre-fix96 ensureCraftingTable threw (src/agent/voyager.js seeded skill, removed by fix96)
export const OAK_ONLY_FAILURE = /ensureCraftingTable needs \d+ more [a-z_]+ but cannot craft it \(no 2x2 recipe or missing sub-ingredients\)/;
const CAUSE = {
    fix: 'fix96',
    name: 'the seeded ensureCraftingTable read only the first crafting_table recipe (oak_planks) and failed while the inventory held other planks/wood; every outcome with its failure text was caused by the bug, not by the goal',
};

export function buildManifest(progress, bot, evidence) {
    if (!progress.goalStats || typeof progress.goalStats !== 'object') throw new Error('progress.goalStats is missing');
    if (!Array.isArray(progress.goalFailStates)) throw new Error('progress.goalFailStates is not a list');
    const records = [];
    for (const [key, stat] of Object.entries(progress.goalStats)) {
        const sep = key.indexOf('::');
        if (sep < 0) continue;
        if (!OAK_ONLY_FAILURE.test(key.slice(sep + 2))) continue;
        records.push({ id: `goalStats.${records.length + 1}`, file: 'progress', path: ['goalStats', key], cause: CAUSE, evidence, expect: stat, delete_path: true });
    }
    const groups = new Map();
    for (const row of progress.goalFailStates) {
        if (row.ok !== false || typeof row.reason !== 'string' || !OAK_ONLY_FAILURE.test(row.reason)) continue;
        const where = { task: row.task, ok: false, reason: row.reason, state: row.state };
        const k = JSON.stringify(where);
        if (groups.has(k)) groups.get(k).n += 1; else groups.set(k, { where, n: 1 });
    }
    let g = 0;
    for (const { where, n } of groups.values()) {
        g += 1;
        records.push({ id: `goalFailStates.${g}`, file: 'progress', path: ['goalFailStates'], cause: CAUSE, evidence, delete_entries_where: where, expect_count: n });
    }
    if (!records.length) throw new Error('no outcome carries the pre-fix96 ensureCraftingTable failure text; nothing to reset');
    return {
        version: 1, bot,
        inventory: 'fix96: outcomes learned from the oak-only ensureCraftingTable failure (goalStats posteriors and same-state failure rows).',
        files: { index: 'skills/index.json', progress: 'skills/progress.json' },
        records,
    };
}

function arg(name) {
    const p = `--${name}=`;
    const hit = process.argv.find(a => a.startsWith(p));
    if (!hit) throw new Error(`--${name}= is required`);
    return hit.slice(p.length);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const botsDir = resolve(arg('bots-dir'));
        const progressPath = join(botsDir, 'skills', 'progress.json');
        const progress = JSON.parse(readFileSync(progressPath, 'utf8'));
        const bot = botsDir.split('/').filter(Boolean).pop();
        process.stdout.write(JSON.stringify(buildManifest(progress, bot, `${progressPath} read ${new Date().toISOString()}`), null, 2) + '\n');
    } catch (e) { console.error(`[fix96-manifest] FAILED: ${e.message}`); process.exit(1); }
}
