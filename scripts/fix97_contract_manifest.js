#!/usr/bin/env node
/**
 * fix97: dry-run manifest of learned contracts whose pre/post use a numeric literal that is not a code literal
 * (comments and strings do not count), not recorded evidence, and not a minecraft-data fact of the field being
 * compared. A code comparison that equals an observed count (promptCounts, or consumeEvidence max) is a record too.
 * Nothing is reset. Each record's verdict is one reason line.
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
    name: 'a contract numeric literal that is not a code literal, recorded evidence, or a minecraft-data fact of the field being compared',
};
const COUNT_CAUSE = {
    fix: 'fix97',
    name: 'a code comparison whose literal equals an observed count of that item',
};

// The live index does not store promptCounts, so a scan cannot see checkOakLog. The comparison and its pre were
// the oak_log count (55) copied out of the state at generation time.
const CHECK_OAK_LOG_RESET = [
    {
        id: 'checkOakLog.code.55',
        evidence: 'Observed oak_log count 55 was copied into checkOakLog as counts.oak_log >= 55. The skill index does not store promptCounts, so the scan cannot see this comparison.',
        verdict: 'checkOakLog.code.55: the code compares oak_log >= 55, and 55 is the observed count of oak_log copied into the skill. The count was observed when the skill was generated. It is not a threshold.',
    },
    {
        id: 'checkOakLog.pre.55',
        evidence: 'Observed oak_log count 55 was copied into checkOakLog pre as c.pre.inv.oak_log >= 55. The skill index does not store promptCounts, so the scan cannot see this comparison.',
        verdict: 'checkOakLog.pre.55: checkOakLog compares c.pre.inv.oak_log to 55, and 55 is the observed count of oak_log. A threshold equal to the count observed when the skill was generated is not a game-data fact.',
    },
];

export function buildContractManifest(skills) {
    if (!Array.isArray(skills)) throw new Error('[fix97] skill index must be an array');
    const records = [];
    for (const skill of skills) {
        if (!skill || typeof skill.name !== 'string') throw new Error('[fix97] skill entry has no name');
        if (typeof skill.code === 'string') {
            for (const hit of Voyager.copiedCountComparisons(skill.code, Voyager.observedCountEntries(skill), registry)) {
                records.push({
                    id: `${skill.name}.code.${hit.n}`,
                    file: 'skills',
                    path: [skill.name, 'code'],
                    cause: COUNT_CAUSE,
                    evidence: `${skill.name} compares ${hit.item} ${hit.op} ${hit.n}, and ${hit.source} of ${hit.item} is ${hit.n}`,
                    verdict: `${skill.name}.code.${hit.n}: the code compares ${hit.item} ${hit.op} ${hit.n}, and ${hit.n} is the ${hit.source} count of ${hit.item}. The count was observed when the skill was generated. It is not a threshold.`,
                    apply: false,
                });
            }
        }
        if (!skill.contract) continue;
        if (typeof skill.code !== 'string') throw new Error(`[fix97] ${skill.name} has a contract and no code`);
        for (const field of ['pre', 'post']) {
            const src = skill.contract[field];
            if (typeof src !== 'string') continue;
            for (const hit of Voyager.unsupportedContractDetails(src, skill, registry)) {
                records.push({
                    id: `${skill.name}.${field}.${hit.n}`,
                    file: 'skills',
                    path: [skill.name, 'contract', field],
                    cause: CAUSE,
                    evidence: `${field} literal ${hit.n} on ${Voyager.pathText(hit.path)}`,
                    verdict: `${skill.name}.${field}.${hit.n}: ${hit.verdict}`,
                    apply: false,
                });
            }
        }
    }
    for (const known of CHECK_OAK_LOG_RESET) {
        if (records.some(r => r.id === known.id)) continue;
        records.push({
            id: known.id,
            file: 'skills',
            path: known.id.endsWith('code.55') ? ['checkOakLog', 'code'] : ['checkOakLog', 'contract', 'pre'],
            cause: known.id.endsWith('code.55') ? COUNT_CAUSE : CAUSE,
            evidence: known.evidence,
            verdict: known.verdict,
            apply: false,
        });
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
