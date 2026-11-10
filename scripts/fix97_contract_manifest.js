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
 * A contract that reads c.args[i] past the function's arity, or compares c.args.length to a count outside
 * the required count through the arity (or below the required count, when the function has a rest parameter),
 * is a reset: contract, contractPrev, and contractFail are cleared and the code stays.
 * The predicate list is derived from the AST of each skill. No skill name is hard-coded.
 * Stored stats.calls are one record per distinct value. A record is a recorded call only when
 * its shape is CALL_SHAPE and it has boolean succeeded and violated flags. Anything else,
 * including a value-list example relabelled as CALL_SHAPE, is reset. Duplicate recorded
 * signatures collapse to one example. A calls value that is not a list is reset.
 * The skill names and signatures come from the scan. Nothing is rewritten unless --apply is passed.
 *
 *   node scripts/fix97_contract_manifest.js --bots-dir=bots/icefox2000
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import settings from '../settings.js';
import { Voyager, CALL_SHAPE } from '../src/agent/voyager.js';

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

function callSignature(call) {
    if (call === null || typeof call !== 'object' || Array.isArray(call)) return null;
    if (typeof call.arity !== 'number' || !Array.isArray(call.types) || !Array.isArray(call.values)) return null;
    if (call.types.length !== call.arity || call.values.length !== call.arity) return null;
    return `${call.arity}:${call.types.join(',')}`;
}

// A recorded call is a CALL_SHAPE that was stored with the outcome flags. A value-list example,
// or one relabelled as CALL_SHAPE without those flags, is not a recorded call.
function isRecordedCall(call) {
    if (callSignature(call) === null) return false;
    if (call.shape !== CALL_SHAPE) return false;
    if (typeof call.succeeded !== 'boolean' || typeof call.violated !== 'boolean') return false;
    return true;
}

// Scan-derived. A calls value that is not a list is a reset. A record that is not a recorded
// CALL_SHAPE with succeeded and violated flags is reset, not relabelled. Several recorded
// calls of one signature collapse to the first example.
export function callRecordMigrations(skills) {
    if (!Array.isArray(skills)) throw new Error('[fix97] skill index must be an array');
    const migrations = [];
    for (const skill of skills) {
        if (!skill || typeof skill.name !== 'string') throw new Error('[fix97] skill entry has no name');
        if (!skill.stats || typeof skill.stats !== 'object' || Array.isArray(skill.stats)) continue;
        if (!Object.hasOwn(skill.stats, 'calls')) continue;
        const calls = skill.stats.calls;
        if (!Array.isArray(calls)) {
            migrations.push({
                id: `${skill.name}.stats.calls`,
                skill: skill.name,
                kind: 'reset',
                reason: `${skill.name} stats.calls is not a list of call shapes`,
            });
            continue;
        }
        const unflagged = calls.filter(call => isRecordedCall(call) === false);
        if (unflagged.length > 0) {
            migrations.push({
                id: `${skill.name}.stats.calls.unflagged`,
                skill: skill.name,
                kind: 'reset',
                count: unflagged.length,
                reason: `${skill.name} has ${unflagged.length} call record(s) that are not a recorded ${CALL_SHAPE} with succeeded and violated flags. They are dropped, and the contract is pending its first recorded call when none remain`,
            });
        }
        const groups = new Map();
        for (const call of calls) {
            if (isRecordedCall(call) === false) continue;
            const key = callSignature(call);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(call);
        }
        for (const [key, group] of groups) {
            if (group.length === 1) continue;
            migrations.push({
                id: `${skill.name}.stats.calls.${key}`,
                skill: skill.name,
                kind: 'migrate',
                from: group.length,
                keep: 1,
                arity: group[0].arity,
                types: group[0].types.slice(),
                reason: `${skill.name} has ${group.length} recorded call(s) for arity ${group[0].arity} types ${group[0].types.join(',')}; one value example is kept`,
            });
        }
    }
    return migrations;
}

export function applyCallRecordMigrations(skills) {
    const migrations = callRecordMigrations(skills);
    const touched = new Set(migrations.map(row => row.skill));
    for (const skill of skills) {
        if (touched.has(skill.name) === false) continue;
        if (!Array.isArray(skill.stats.calls)) {
            delete skill.stats.calls;
            continue;
        }
        const kept = [];
        const seen = new Set();
        for (const call of skill.stats.calls) {
            if (isRecordedCall(call) === false) continue;
            const key = callSignature(call);
            if (seen.has(key)) continue;
            seen.add(key);
            kept.push({
                arity: call.arity,
                types: call.types.slice(),
                values: call.values.slice(),
                shape: CALL_SHAPE,
                succeeded: call.succeeded,
                violated: call.violated,
            });
        }
        if (kept.length === 0) delete skill.stats.calls;
        else skill.stats.calls = kept;
    }
    return migrations;
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
        callMigrations: callRecordMigrations(skills),
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
        const callMigrations = applyCallRecordMigrations(skills);
        const resets = applyContractResets(skills);
        writeFileSync(indexPath, JSON.stringify(skills, null, 2));
        process.stdout.write(JSON.stringify({ apply: true, callMigrations, resets }, null, 2) + '\n');
    } else {
        const manifest = buildContractManifest(skills);
        manifest.index = indexPath;
        process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    }
}
