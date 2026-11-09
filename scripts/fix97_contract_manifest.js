#!/usr/bin/env node
/**
 * fix97: dry-run manifest of learned contracts whose pre/post use a numeric literal that is not in the skill's
 * code or recorded evidence (the "Oak log count < 55" precondition). Nothing is reset.
 *
 *   node scripts/fix97_contract_manifest.js --bots-dir=bots/icefox2000
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const CAUSE = {
    fix: 'fix97',
    name: 'a contract numeric literal that is not in the skill source or recorded evidence was invented by the contract model',
};

function literals(src) {
    const out = [];
    const re = /(?<![.\w])(\d+(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(String(src)))) out.push(m[1]);
    return out;
}

export function buildContractManifest(skills) {
    if (!Array.isArray(skills)) throw new Error('[fix97] skill index must be an array');
    const records = [];
    for (const skill of skills) {
        if (!skill || typeof skill.name !== 'string') throw new Error('[fix97] skill entry has no name');
        if (!skill.contract) continue;
        const evidence = JSON.stringify({
            consumes: skill.consumes, effects: skill.effects, consumeEvidence: skill.consumeEvidence,
            effectEvidence: skill.effectEvidence, observedRuns: skill.observedRuns, stats: skill.stats,
        });
        const code = typeof skill.code === 'string' ? skill.code : '';
        for (const field of ['pre', 'post']) {
            const src = skill.contract[field];
            if (typeof src !== 'string') continue;
            for (const token of literals(src)) {
                if (token === '0' || token === '1') continue;
                if (code.includes(token) || evidence.includes(token)) continue;
                records.push({
                    id: `${skill.name}.${field}.${token}`,
                    file: 'skills',
                    path: [skill.name, 'contract', field],
                    cause: CAUSE,
                    evidence: `${field} literal ${token} is not in the skill code or recorded evidence`,
                    apply: false,
                });
            }
        }
    }
    return {
        fix: 'fix97',
        dryRun: true,
        apply: false,
        checkOakLogPresent: skills.some(s => s.name === 'checkOakLog'),
        scanned: skills.length,
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
