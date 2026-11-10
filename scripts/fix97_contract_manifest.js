#!/usr/bin/env node
/**
 * fix97: dry-run manifest of copied inventory counts.
 * A record is a comparison whose one side resolves to an inventory count of item X
 * (c.pre.inv.X, c.post.inv.X, c.delta.X, or a getInventoryCounts binding) and whose other side is a numeric literal
 * equal to the count of X observed when the skill was generated. A subscript, a distance, sky light, a tier, an
 * argument count, or a tool-set size is not that comparison. A goal quantity ("Craft 4 birch_planks") is not the
 * observation. Nothing is reset. Each record's verdict is one reason line.
 *
 * The observation is promptCounts when the skill stored it. Otherwise it is the task, the description, or a
 * repairHistory evidence: the curriculum writes the task from the inventory it just observed, and that state lists
 * items as name:count. The number is paired with the nearest item id in that text. The word that introduced the
 * number is not matched.
 *
 *   node scripts/fix97_contract_manifest.js --bots-dir=bots/icefox2000
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import settings from '../settings.js';
import { Voyager } from '../src/agent/voyager.js';

const require = createRequire(import.meta.url);
const registry = require('minecraft-data')(settings.minecraft_version);

const CAUSE = {
    fix: 'fix97',
    name: 'a comparison of an inventory count of item X to a numeric literal equal to the count of X observed when the skill was generated',
};

function evidenceOf(skill, hit) {
    const comparison = `${hit.item} ${hit.op} ${hit.n}`;
    if (hit.source === 'promptCounts') {
        return `${skill.name} promptCounts records ${hit.item} at ${hit.n}. That is the inventory in the code prompt when the skill was generated. The comparison ${comparison} copies it. It is not the goal quantity of ${hit.item}.`;
    }
    return `${skill.name} ${hit.source} records ${hit.item} at ${hit.n}: ${JSON.stringify(hit.quote)}. The curriculum writes that text from the inventory it observed, and that state lists items as name:count. The comparison ${comparison} copies that count. It is not the goal quantity of ${hit.item}.`;
}

export function buildContractManifest(skills) {
    if (!Array.isArray(skills)) throw new Error('[fix97] skill index must be an array');
    const records = [];
    const seen = new Set();
    for (const skill of skills) {
        if (!skill || typeof skill.name !== 'string') throw new Error('[fix97] skill entry has no name');
        for (const hit of Voyager.copiedInventoryHits(skill, registry)) {
            const id = `${skill.name}.${hit.where}.${hit.n}`;
            const evidence = evidenceOf(skill, hit);
            if (seen.has(id)) {
                const prev = records.find(r => r.id === id);
                if (prev.evidence !== evidence) throw new Error(`[fix97] ${id} is two different comparisons (${prev.evidence}) and (${evidence})`);
                continue;
            }
            seen.add(id);
            const wherePath = hit.where === 'code' ? [skill.name, 'code'] : [skill.name, 'contract', hit.where];
            records.push({
                id,
                file: 'skills',
                path: wherePath,
                cause: CAUSE,
                evidence,
                verdict: `${id}: the ${hit.where} compares ${hit.item} ${hit.op} ${hit.n}, and ${hit.n} is the ${hit.source} count of ${hit.item}. The count was observed when the skill was generated. It is not a threshold.`,
                apply: false,
            });
        }
    }
    const reasonLines = records.map(r => r.verdict);
    return {
        fix: 'fix97',
        dryRun: true,
        apply: false,
        checkOakLogPresent: skills.some(s => s.name === 'checkOakLog'),
        scanned: skills.length,
        reasonLines,
        records,
    };
}

function arg(name) {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    if (!hit) return null;
    return hit.slice(name.length + 3);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const bots = arg('bots-dir');
    if (!bots) throw new Error('[fix97] --bots-dir=bots/icefox2000 required');
    const indexPath = join(bots, 'skills', 'index.json');
    const skills = JSON.parse(readFileSync(indexPath, 'utf8'));
    const manifest = buildContractManifest(skills);
    manifest.index = indexPath;
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}
