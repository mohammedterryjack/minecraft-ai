#!/usr/bin/env node
/**
 * fix97: dry-run manifest of copied inventory counts.
 * A record is a comparison whose one side resolves to an inventory count of item X
 * (c.pre.inv.X, c.post.inv.X, c.delta.X, or a getInventoryCounts binding) and whose other side is a numeric literal
 * that is not X's goal quantity, not a minecraft-data stack or recipe count for X, and not 0 or 1.
 * The goal quantity comes from countGoal / smeltGoal / ensureGoal / reachGoal. A leading "kind:" label
 * (collectSurface: Collect 32 dirt) is that parser's grammar. Task prose is not a source of counts.
 * A subscript, a distance, sky light, a tier, an argument count, or a tool-set size is not an inventory comparison.
 * Each record's verdict is one reason line.
 * A contract that reads c.args[i] past the function's arity, or compares c.args.length to anything other than
 * the required count or the arity, is a reset: contract, contractPrev, and contractFail are cleared and the code stays.
 * The predicate list is derived from the AST of each skill. No skill name is hard-coded.
 *
 *   node scripts/fix97_contract_manifest.js --bots-dir=bots/icefox2000
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import settings from '../settings.js';
import { Voyager } from '../src/agent/voyager.js';

const require = createRequire(import.meta.url);
const registry = require('minecraft-data')(settings.minecraft_version);

const CAUSE = {
    fix: 'fix97',
    name: 'a comparison of an inventory count of item X to a numeric literal that is not the parsed goal quantity of X, not a minecraft-data stack or recipe count for X, and not 0 or 1',
};

function evidenceOf(skill, hit) {
    const comparison = `${hit.item} ${hit.op} ${hit.n}`;
    return `${skill.name} compares inventory ${comparison}. ${hit.n} is not the parsed goal quantity of ${hit.item}, not a minecraft-data stack or recipe count for ${hit.item}, and not 0 or 1.`;
}

export function contractArityResets(skills) {
    if (!Array.isArray(skills)) throw new Error('[fix97] skill index must be an array');
    const resets = [];
    const seen = new Set();
    for (const skill of skills) {
        if (!skill || typeof skill.name !== 'string') throw new Error('[fix97] skill entry has no name');
        if (!skill.contract || typeof skill.contract !== 'object') continue;
        if (typeof skill.code !== 'string') throw new Error(`[fix97] ${skill.name} has a contract and no code`);
        for (const where of ['pre', 'post']) {
            const src = skill.contract[where];
            if (typeof src !== 'string') continue;
            for (const problem of Voyager.contractArgProblems(src, skill)) {
                const id = problem.kind === 'index'
                    ? `${skill.name}.${where}.args[${problem.index}]`
                    : `${skill.name}.${where}.args.length.${problem.n}`;
                if (seen.has(id)) continue;
                seen.add(id);
                resets.push({
                    id,
                    skill: skill.name,
                    where,
                    kind: problem.kind,
                    index: problem.kind === 'index' ? problem.index : null,
                    n: problem.kind === 'length' ? problem.n : null,
                    text: problem.text,
                });
            }
        }
    }
    return resets;
}

export function applyContractResets(skills) {
    const resets = contractArityResets(skills);
    const names = new Set(resets.map(r => r.skill));
    for (const skill of skills) {
        if (!names.has(skill.name)) continue;
        delete skill.contract;
        delete skill.contractPrev;
        delete skill.contractFail;
    }
    return resets;
}

export function buildContractManifest(skills) {
    if (!Array.isArray(skills)) throw new Error('[fix97] skill index must be an array');
    const records = [];
    const seen = new Set();
    for (const skill of skills) {
        if (!skill || typeof skill.name !== 'string') throw new Error('[fix97] skill entry has no name');
        for (const hit of Voyager.copiedInventoryHits(skill, registry)) {
            const id = `${skill.name}.${hit.where}.${hit.item}.${hit.n}`;
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
                verdict: `${id}: the ${hit.where} compares ${hit.item} ${hit.op} ${hit.n}. ${hit.n} is not the parsed goal quantity of ${hit.item}, not a minecraft-data stack or recipe count for ${hit.item}, and not 0 or 1.`,
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
        resets: contractArityResets(skills),
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
    if (process.argv.includes('--apply')) {
        const resets = applyContractResets(skills);
        writeFileSync(indexPath, JSON.stringify(skills, null, 2));
        process.stdout.write(JSON.stringify({ apply: true, resets }, null, 2) + '\n');
    } else {
        const manifest = buildContractManifest(skills);
        manifest.index = indexPath;
        process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    }
}
