#!/usr/bin/env node
/**
 * fix103: remove learned records written for one goal inside a time window.
 *
 *   node scripts/fix103-reset.js <botDir> <goal> <isoFrom> <isoTo>           # dry-run
 *   node scripts/fix103-reset.js <botDir> <goal> <isoFrom> <isoTo> --apply   # write
 *
 * botDir is the bot folder (bots/<name>), the parent of skills/.
 *
 * The mindcraft log lines have no timestamps. The operator picks the window.
 * For the 2026-11-10 keep-alive kill, the 'reach iron_ore' step was popped at
 * 15:53:50.975Z and the watchdog killed the process at 15:57:42.339Z, so a
 * window that covers that false failure is:
 *
 *   2026-11-10T15:53:50Z  2026-11-10T15:57:43Z
 *
 * Dry-run is the default. --apply rewrites only the files it changes and leaves
 * a sibling <file>.fix103-bak the first time (it does not overwrite that backup).
 *
 * An event record (one record, one timestamp) for this goal is removed when its
 * timestamp is inside the window, inclusive. A record for this goal in a
 * timestamped log that has no parseable timestamp is an error: the script
 * writes nothing. Counters and lists that do not store a time per event are
 * printed and left in place. This script does not guess a new count.
 */
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, unlinkSync, realpathSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));

function argValue(name) {
    const prefix = `--${name}=`;
    const hit = process.argv.find((a) => a.startsWith(prefix));
    if (hit === undefined) return null;
    return hit.slice(prefix.length);
}

function hasFlag(name) {
    return process.argv.includes(`--${name}`);
}

export function parseInstant(text, where) {
    if (typeof text !== 'string' || text.length === 0) throw new Error(`fix103-reset: ${where} is not an ISO time: ${JSON.stringify(text)}`);
    const t = Date.parse(text);
    if (Number.isNaN(t)) throw new Error(`fix103-reset: ${where} is not a parseable time: ${JSON.stringify(text)}`);
    return t;
}

function timeOf(value, where) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`fix103-reset: ${where} is not a finite epoch-ms timestamp: ${JSON.stringify(value)}`);
        return value;
    }
    if (typeof value === 'string') return parseInstant(value, where);
    throw new Error(`fix103-reset: ${where} has no timestamp (${value === undefined ? 'missing' : typeof value}); refusing to guess whether it is inside the window`);
}

function inWindow(t, from, to) {
    return t >= from && t <= to;
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function findOne(botDir, label, rels) {
    const hits = [];
    for (const rel of rels) {
        const path = join(botDir, rel);
        if (existsSync(path)) hits.push(path);
    }
    if (hits.length > 1) throw new Error(`fix103-reset: ${label} exists in more than one place: ${hits.join(', ')}`);
    if (hits.length === 0) return null;
    return hits[0];
}

function goalKey(key, goal) {
    return key === goal || key.startsWith(`${goal}::`);
}

function requireObject(value, where) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`fix103-reset: ${where} is not an object: ${JSON.stringify(value)}`);
    return value;
}

function requireArray(value, where) {
    if (!Array.isArray(value)) throw new Error(`fix103-reset: ${where} is not an array: ${JSON.stringify(value)}`);
    return value;
}

const HAND_RESET = [
    'progress.failed is a list of task strings and has no timestamps',
    'progress.goalStats is {success, fail} per goal::reason and has no timestamps',
    'progress.goalFailures stores success/fail plus lastFail (the latest failure only), so a count cannot be split',
    'progress.goalFailStates entries have task/ok/reason/state and no timestamps',
    'progress.recipeEdges runs/fails have no per-run timestamps',
    'progress.blockers have no timestamps',
    'progress.repairQueue and progress.deferredRepairs have no queued-at',
    'progress.subgoals have no timestamps (decomposed[goal].at is the decomposition time and is edited on its own)',
    'progress.failedRepairSigs is keyed by skill hash and evidence, not by the goal',
    'progress.libraryFaults, progress.vitals.runs, progress.slots.runs, progress.movement, progress.botApiDurations, progress.callDurations are counters with no per-event timestamps and are not keyed by the goal',
    'skill.stats success/fail/streakFail and skill.demoted have no per-run or demotion time (prunedAt is only the prune path). skill.runMs is the same kind of counter. A step failure increments fail without recording which skill',
    'needs_produces.json observations[].runs is a counter. lastRun is one timestamp, not a log of runs',
    'deathSpots.tasks is capped at 5 and deathSpots.times at 20; they are not paired, so a death during the goal cannot be removed',
    'progress.completed and progress.completedAt record successes, not this failure',
];

function loadOptional(files, path) {
    if (path === null) return null;
    const value = readJson(path);
    files.set(path, { value, original: JSON.stringify(value), dirty: false });
    return value;
}

function mark(files, path) {
    const rec = files.get(path);
    if (!rec) throw new Error(`fix103-reset: no loaded file for ${path}`);
    rec.dirty = true;
}

export function planReset(botDir, goal, fromIso, toIso) {
    if (typeof botDir !== 'string' || botDir.length === 0) throw new Error('fix103-reset: botDir is required');
    if (typeof goal !== 'string' || goal.length === 0) throw new Error('fix103-reset: goal is required');
    const from = parseInstant(fromIso, 'isoFrom');
    const to = parseInstant(toIso, 'isoTo');
    if (from > to) throw new Error(`fix103-reset: isoFrom ${fromIso} is after isoTo ${toIso}`);
    const root = resolve(botDir);
    if (!existsSync(root)) throw new Error(`fix103-reset: bot dir does not exist: ${root}`);

    const changes = [];
    const manual = [];
    const files = new Map();

    const progressPath = findOne(root, 'progress.json', ['skills/progress.json', 'progress.json']);
    const indexPath = findOne(root, 'index.json', ['skills/index.json', 'index.json']);
    const repairPath = findOne(root, 'repair_memory.json', ['repair_memory.json', 'skills/repair_memory.json']);
    const idlePath = findOne(root, 'idle_practice.json', ['idle_practice.json', 'skills/idle_practice.json']);
    const needsPath = findOne(root, 'needs_produces.json', ['needs_produces.json', 'skills/needs_produces.json']);
    const trialsPath = findOne(root, 'trials_inflight.json', ['skills/trials_inflight.json', 'trials_inflight.json']);

    const progress = progressPath === null ? null : requireObject(loadOptional(files, progressPath), progressPath);
    const index = indexPath === null ? null : requireArray(loadOptional(files, indexPath), indexPath);
    const repair = repairPath === null ? null : requireObject(loadOptional(files, repairPath), repairPath);
    const idle = idlePath === null ? null : requireObject(loadOptional(files, idlePath), idlePath);
    const needs = needsPath === null ? null : requireObject(loadOptional(files, needsPath), needsPath);
    const trials = trialsPath === null ? null : requireObject(loadOptional(files, trialsPath), trialsPath);

    if (progressPath === null) manual.push('no progress.json under the bot dir');
    if (indexPath === null) manual.push('no skills/index.json under the bot dir');

    if (progress !== null) {
        if (Array.isArray(progress.failed)) {
            for (let i = 0; i < progress.failed.length; i++) {
                const entry = progress.failed[i];
                if (entry === goal || (typeof entry === 'string' && entry.startsWith(`${goal} (`))) {
                    manual.push(`${progressPath} failed[${i}] ${JSON.stringify(entry)} has no timestamp; left in place`);
                }
            }
        }
        if (progress.goalStats !== null && typeof progress.goalStats === 'object' && !Array.isArray(progress.goalStats)) {
            for (const [key, value] of Object.entries(progress.goalStats)) {
                if (!goalKey(key, goal)) continue;
                manual.push(`${progressPath} goalStats[${JSON.stringify(key)}] = ${JSON.stringify(value)} has no timestamp; left in place`);
            }
        }
        if (progress.goalFailures !== null && typeof progress.goalFailures === 'object' && !Array.isArray(progress.goalFailures)) {
            for (const [key, value] of Object.entries(progress.goalFailures)) {
                if (!goalKey(key, goal)) continue;
                manual.push(`${progressPath} goalFailures[${JSON.stringify(key)}] = ${JSON.stringify(value)} cannot be split by lastFail; left in place`);
            }
        }
        if (Array.isArray(progress.goalFailStates)) {
            for (let i = 0; i < progress.goalFailStates.length; i++) {
                const row = progress.goalFailStates[i];
                if (row !== null && typeof row === 'object' && row.task === goal) {
                    manual.push(`${progressPath} goalFailStates[${i}] ${JSON.stringify(row)} has no timestamp; left in place`);
                }
            }
        }
        if (progress.recipeEdges !== null && typeof progress.recipeEdges === 'object' && !Array.isArray(progress.recipeEdges)) {
            for (const [item, edge] of Object.entries(progress.recipeEdges)) {
                if (edge === null || typeof edge !== 'object' || edge.task !== goal) continue;
                manual.push(`${progressPath} recipeEdges[${JSON.stringify(item)}] task=${JSON.stringify(goal)} runs=${JSON.stringify(edge.runs)} fails=${JSON.stringify(edge.fails)} has no per-run timestamp; left in place`);
            }
        }
        if (Array.isArray(progress.blockers)) {
            for (let i = 0; i < progress.blockers.length; i++) {
                const row = progress.blockers[i];
                if (row !== null && typeof row === 'object' && row.task === goal) {
                    manual.push(`${progressPath} blockers[${i}] ${JSON.stringify(row)} has no timestamp; left in place`);
                }
            }
        }
        for (const queueName of ['repairQueue', 'deferredRepairs']) {
            if (!Array.isArray(progress[queueName])) continue;
            for (let i = 0; i < progress[queueName].length; i++) {
                const row = progress[queueName][i];
                if (row !== null && typeof row === 'object' && row.task === goal) {
                    manual.push(`${progressPath} ${queueName}[${i}] target=${JSON.stringify(row.target)} has no queued-at; left in place`);
                }
            }
        }
        if (Array.isArray(progress.subgoals)) {
            for (let i = 0; i < progress.subgoals.length; i++) {
                const row = progress.subgoals[i];
                if (row !== null && typeof row === 'object' && (row.task === goal || row.parent === goal)) {
                    manual.push(`${progressPath} subgoals[${i}] task=${JSON.stringify(row.task)} parent=${JSON.stringify(row.parent)} has no timestamp; left in place`);
                }
            }
        }
        if (progress.decomposeQueue !== null && typeof progress.decomposeQueue === 'object' && !Array.isArray(progress.decomposeQueue) && progress.decomposeQueue.task === goal) {
            manual.push(`${progressPath} decomposeQueue ${JSON.stringify(progress.decomposeQueue)} has no timestamp; left in place`);
        }
        if (progress.decomposed !== null && typeof progress.decomposed === 'object' && !Array.isArray(progress.decomposed) && Object.hasOwn(progress.decomposed, goal)) {
            const rec = progress.decomposed[goal];
            requireObject(rec, `${progressPath} decomposed[${JSON.stringify(goal)}]`);
            if (!Object.hasOwn(rec, 'at')) throw new Error(`fix103-reset: ${progressPath} decomposed[${JSON.stringify(goal)}] has no at; refusing to guess whether it is inside the window`);
            const t = timeOf(rec.at, `${progressPath} decomposed[${JSON.stringify(goal)}].at`);
            if (inWindow(t, from, to)) {
                delete progress.decomposed[goal];
                mark(files, progressPath);
                changes.push(`REMOVE ${progressPath} decomposed[${JSON.stringify(goal)}] at ${new Date(t).toISOString()}`);
            }
        }
        if (progress.deathSpots !== null && typeof progress.deathSpots === 'object' && !Array.isArray(progress.deathSpots)) {
            for (const [cell, spot] of Object.entries(progress.deathSpots)) {
                if (spot === null || typeof spot !== 'object' || !Array.isArray(spot.tasks)) continue;
                if (!spot.tasks.includes(goal)) continue;
                manual.push(`${progressPath} deathSpots[${JSON.stringify(cell)}].tasks includes ${JSON.stringify(goal)} but times (len ${Array.isArray(spot.times) ? spot.times.length : 'missing'}) are not paired with tasks (len ${spot.tasks.length}); left in place`);
            }
        }
    }

    if (index !== null) {
        for (const skill of index) {
            if (skill === null || typeof skill !== 'object' || typeof skill.name !== 'string') continue;
            if (!Array.isArray(skill.repairHistory)) continue;
            const kept = [];
            for (let i = 0; i < skill.repairHistory.length; i++) {
                const row = skill.repairHistory[i];
                requireObject(row, `${indexPath} ${skill.name}.repairHistory[${i}]`);
                if (!Object.hasOwn(row, 'at')) throw new Error(`fix103-reset: ${indexPath} ${skill.name}.repairHistory[${i}] has no at; refusing to guess whether it is inside the window`);
                if (!Object.hasOwn(row, 'task')) {
                    manual.push(`${indexPath} ${skill.name}.repairHistory[${i}] has no task (at ${JSON.stringify(row.at)}); left in place`);
                    kept.push(row);
                    continue;
                }
                if (row.task !== goal) {
                    kept.push(row);
                    continue;
                }
                const t = timeOf(row.at, `${indexPath} ${skill.name}.repairHistory[${i}].at`);
                if (!inWindow(t, from, to)) {
                    kept.push(row);
                    continue;
                }
                mark(files, indexPath);
                changes.push(`REMOVE ${indexPath} ${skill.name}.repairHistory[${i}] at ${new Date(t).toISOString()} task=${JSON.stringify(goal)}`);
            }
            if (kept.length !== skill.repairHistory.length) skill.repairHistory = kept;
        }
    }

    if (repair !== null) {
        for (const listName of ['repairs', 'workflows']) {
            if (!Object.hasOwn(repair, listName)) continue;
            const list = requireArray(repair[listName], `${repairPath} ${listName}`);
            const taskField = listName === 'repairs' ? 'taskHint' : 'task';
            const kept = [];
            for (let i = 0; i < list.length; i++) {
                const row = requireObject(list[i], `${repairPath} ${listName}[${i}]`);
                if (!Object.hasOwn(row, 'timestamp')) throw new Error(`fix103-reset: ${repairPath} ${listName}[${i}] has no timestamp; refusing to guess whether it is inside the window`);
                if (!Object.hasOwn(row, taskField)) throw new Error(`fix103-reset: ${repairPath} ${listName}[${i}] has no ${taskField}; refusing to guess whether it is for ${JSON.stringify(goal)}`);
                if (row[taskField] !== goal) {
                    kept.push(row);
                    continue;
                }
                const t = timeOf(row.timestamp, `${repairPath} ${listName}[${i}].timestamp`);
                if (!inWindow(t, from, to)) {
                    kept.push(row);
                    continue;
                }
                mark(files, repairPath);
                changes.push(`REMOVE ${repairPath} ${listName}[${i}] id=${JSON.stringify(row.id)} timestamp=${new Date(t).toISOString()} ${taskField}=${JSON.stringify(goal)}`);
            }
            if (kept.length !== list.length) repair[listName] = kept;
        }
    }

    if (idle !== null) {
        if (Object.hasOwn(idle, 'practiceLog')) {
            const list = requireArray(idle.practiceLog, `${idlePath} practiceLog`);
            const kept = [];
            for (let i = 0; i < list.length; i++) {
                const row = requireObject(list[i], `${idlePath} practiceLog[${i}]`);
                if (!Object.hasOwn(row, 'timestamp')) throw new Error(`fix103-reset: ${idlePath} practiceLog[${i}] has no timestamp; refusing to guess whether it is inside the window`);
                if (!Object.hasOwn(row, 'goal')) throw new Error(`fix103-reset: ${idlePath} practiceLog[${i}] has no goal; refusing to guess whether it is for ${JSON.stringify(goal)}`);
                if (row.goal !== goal) {
                    kept.push(row);
                    continue;
                }
                const t = timeOf(row.timestamp, `${idlePath} practiceLog[${i}].timestamp`);
                if (!inWindow(t, from, to)) {
                    kept.push(row);
                    continue;
                }
                mark(files, idlePath);
                changes.push(`REMOVE ${idlePath} practiceLog[${i}] timestamp=${new Date(t).toISOString()} goal=${JSON.stringify(goal)}`);
            }
            if (kept.length !== list.length) idle.practiceLog = kept;
        }
        if (Object.hasOwn(idle, 'gaps')) {
            const list = requireArray(idle.gaps, `${idlePath} gaps`);
            const kept = [];
            const goalFold = goal.toLowerCase();
            for (let i = 0; i < list.length; i++) {
                const row = requireObject(list[i], `${idlePath} gaps[${i}]`);
                if (!Object.hasOwn(row, 'task')) throw new Error(`fix103-reset: ${idlePath} gaps[${i}] has no task; refusing to guess whether it is for ${JSON.stringify(goal)}`);
                if (row.task !== goalFold) {
                    kept.push(row);
                    continue;
                }
                if (!Object.hasOwn(row, 'firstSeen') || !Object.hasOwn(row, 'lastSeen')) throw new Error(`fix103-reset: ${idlePath} gaps[${i}] for ${JSON.stringify(goal)} lacks firstSeen or lastSeen; refusing to guess`);
                const first = timeOf(row.firstSeen, `${idlePath} gaps[${i}].firstSeen`);
                const last = timeOf(row.lastSeen, `${idlePath} gaps[${i}].lastSeen`);
                const whollyInside = inWindow(first, from, to) && inWindow(last, from, to);
                const overlaps = first <= to && last >= from;
                if (whollyInside) {
                    mark(files, idlePath);
                    changes.push(`REMOVE ${idlePath} gaps[${i}] task=${JSON.stringify(row.task)} firstSeen=${new Date(first).toISOString()} lastSeen=${new Date(last).toISOString()} count=${JSON.stringify(row.count)}`);
                    continue;
                }
                kept.push(row);
                if (overlaps) {
                    manual.push(`${idlePath} gaps[${i}] task=${JSON.stringify(row.task)} count=${JSON.stringify(row.count)} spans ${new Date(first).toISOString()}..${new Date(last).toISOString()}, which overlaps the window; the count is cumulative and has no per-increment timestamps; left in place`);
                }
            }
            if (kept.length !== list.length) idle.gaps = kept;
        }
    }

    if (needs !== null && needs.observations !== null && typeof needs.observations === 'object' && !Array.isArray(needs.observations)) {
        for (const [key, obs] of Object.entries(needs.observations)) {
            if (obs === null || typeof obs !== 'object') continue;
            if (!Object.hasOwn(obs, 'lastRun')) {
                manual.push(`${needsPath} observations[${JSON.stringify(key)}] has no lastRun; the runs counter was not edited`);
                continue;
            }
            const t = timeOf(obs.lastRun, `${needsPath} observations[${JSON.stringify(key)}].lastRun`);
            if (!inWindow(t, from, to)) continue;
            manual.push(`${needsPath} observations[${JSON.stringify(key)}] lastRun=${new Date(t).toISOString()} runs=${JSON.stringify(obs.runs)} is a counter; left in place`);
        }
    }

    let deleteTrials = false;
    if (trials !== null) {
        if (!Object.hasOwn(trials, 'task')) throw new Error(`fix103-reset: ${trialsPath} has no task; refusing to guess whether it is for ${JSON.stringify(goal)}`);
        if (!Object.hasOwn(trials, 'startedAt')) throw new Error(`fix103-reset: ${trialsPath} has no startedAt; refusing to guess whether it is inside the window`);
        if (trials.task === goal) {
            const t = timeOf(trials.startedAt, `${trialsPath} startedAt`);
            if (inWindow(t, from, to)) {
                deleteTrials = true;
                changes.push(`DELETE ${trialsPath} task=${JSON.stringify(goal)} startedAt=${new Date(t).toISOString()}`);
            }
        }
    }

    return { root, goal, from, to, fromIso, toIso, changes, manual, files, deleteTrials, trialsPath };
}

function writeChanged(plan, log) {
    for (const [path, rec] of plan.files) {
        if (rec.dirty !== true) continue;
        const text = `${JSON.stringify(rec.value, null, 2)}\n`;
        if (text === readFileSync(path, 'utf8')) continue;
        const bak = `${path}.fix103-bak`;
        if (!existsSync(bak)) {
            copyFileSync(path, bak);
            log(`BACKUP ${bak}`);
        } else {
            log(`BACKUP already present, left in place: ${bak}`);
        }
        const tmp = `${path}.tmp-${process.pid}`;
        writeFileSync(tmp, text);
        renameSync(tmp, path);
        log(`WROTE ${path}`);
    }
    if (plan.deleteTrials === true) {
        if (!existsSync(plan.trialsPath)) return;
        const bak = `${plan.trialsPath}.fix103-bak`;
        if (!existsSync(bak)) {
            copyFileSync(plan.trialsPath, bak);
            log(`BACKUP ${bak}`);
        } else {
            log(`BACKUP already present, left in place: ${bak}`);
        }
        unlinkSync(plan.trialsPath);
        log(`DELETED ${plan.trialsPath}`);
    }
}

export function resetLearned(botDir, goal, fromIso, toIso, apply, log = console.log) {
    const plan = planReset(botDir, goal, fromIso, toIso);
    log(`fix103-reset botDir=${plan.root} goal=${JSON.stringify(plan.goal)} window=[${plan.fromIso}, ${plan.toIso}] mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
    log('Log lines have no timestamps. The operator chooses the window. Example covering the reach iron_ore step pop through the 15:57:42.339Z kill: 2026-11-10T15:53:50Z 2026-11-10T15:57:43Z');
    if (plan.changes.length === 0) log('NO timestamped records for this goal inside the window.');
    for (const line of plan.changes) log(`${apply ? 'APPLY' : 'WOULD'} ${line}`);
    log('NOT EDITED (no per-event timestamps, or not keyed by this goal). Reset these by hand if this failure wrote them:');
    for (const line of HAND_RESET) log(`  - ${line}`);
    if (plan.manual.length === 0) log('No records for this goal were found in those stores.');
    for (const line of plan.manual) log(`MANUAL ${line}`);
    log(`${plan.changes.length} timestamped change(s), ${plan.manual.length} manual note(s).`);
    if (apply) writeChanged(plan, log);
    else log('DRY-RUN, no files written.');
    return plan;
}

function invokedDirectly() {
    if (!process.argv[1]) return false;
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) {
    const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    if (positional.length !== 4) {
        throw new Error('usage: node scripts/fix103-reset.js <botDir> <goal> <isoFrom> <isoTo> [--apply]');
    }
    const apply = hasFlag('apply');
    if (argValue('apply') !== null) throw new Error('fix103-reset: pass --apply as a flag, not --apply=');
    resetLearned(positional[0], positional[1], positional[2], positional[3], apply);
}
