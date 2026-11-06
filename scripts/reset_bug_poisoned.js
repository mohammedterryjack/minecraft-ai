#!/usr/bin/env node
/**
 * fix76: reset icefox learned records poisoned by fixed bugs.
 * Drive from scripts/bug_poisoned_manifest.json only (no inline skill lists).
 *
 *   node scripts/reset_bug_poisoned.js --bots-dir=bots/icefox2000            # dry-run (default)
 *   node scripts/reset_bug_poisoned.js --bots-dir=bots/icefox2000 --apply  # write after backup
 *   node scripts/reset_bug_poisoned.js --manifest=path --bots-dir=path
 *
 * Fails loud if any expect.* does not match the file on disk (refuses to apply a stale manifest).
 * Does NOT invent eatCookedMutton.candidate code.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function arg(name, def = null) {
    const p = `--${name}=`;
    const hit = process.argv.find(a => a.startsWith(p));
    if (hit) return hit.slice(p.length);
    if (process.argv.includes(`--${name}`)) return true;
    return def;
}

function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function getAt(obj, dottedOrParts) {
    const parts = Array.isArray(dottedOrParts) ? dottedOrParts : String(dottedOrParts).split('.');
    let cur = obj;
    for (const p of parts) {
        if (cur === null || cur === undefined || typeof cur !== 'object' || !Object.hasOwn(cur, p)) return { ok: false, value: undefined, parts };
        cur = cur[p];
    }
    return { ok: true, value: cur, parts };
}

function setAt(obj, dotted, value) {
    const parts = String(dotted).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!Object.hasOwn(cur, p) || typeof cur[p] !== 'object' || cur[p] === null) throw new Error(`setAt: missing parent ${parts.slice(0, i + 1).join('.')}`);
        cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
}

function deleteAt(obj, dotted) {
    const parts = String(dotted).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!Object.hasOwn(cur, parts[i])) return false;
        cur = cur[parts[i]];
    }
    if (!Object.hasOwn(cur, parts[parts.length - 1])) return false;
    delete cur[parts[parts.length - 1]];
    return true;
}

function deletePath(root, pathParts) {
    if (!pathParts.length) throw new Error('deletePath: empty path');
    let cur = root;
    for (let i = 0; i < pathParts.length - 1; i++) {
        if (!Object.hasOwn(cur, pathParts[i])) return false;
        cur = cur[pathParts[i]];
        if (cur === null || typeof cur !== 'object') throw new Error(`deletePath: not an object at ${pathParts.slice(0, i + 1).join('.')}`);
    }
    const last = pathParts[pathParts.length - 1];
    if (!Object.hasOwn(cur, last)) return false;
    delete cur[last];
    return true;
}

function findSkill(index, name) {
    if (!Array.isArray(index)) throw new Error('index.json must be an array of skills');
    const i = index.findIndex(s => s && s.name === name);
    if (i < 0) throw new Error(`skill not found in index: ${name}`);
    return { skill: index[i], index: i };
}

function readJson(path) {
    if (!existsSync(path)) throw new Error(`missing file: ${path}`);
    return JSON.parse(readFileSync(path, 'utf8'));
}

function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export function loadManifest(manifestPath) {
    const m = readJson(manifestPath);
    if (m.version !== 1) throw new Error(`unsupported manifest version: ${m.version}`);
    if (!Array.isArray(m.records) || !m.records.length) throw new Error('manifest.records must be a non-empty array');
    if (!m.files?.index || !m.files?.progress) throw new Error('manifest.files.index and .progress are required');
    return m;
}

export function applyManifest({ manifest, botsDir, apply = false, log = console.log }) {
    const indexPath = join(botsDir, manifest.files.index);
    const progressPath = join(botsDir, manifest.files.progress);
    const index = readJson(indexPath);
    const progress = readJson(progressPath);
    const changes = [];
    const mismatches = [];

    for (const rec of manifest.records) {
        const label = rec.id;
        if (rec.file === 'index') {
            if (!rec.skill) throw new Error(`${label}: index record needs skill`);
            const { skill } = findSkill(index, rec.skill);
            for (const [k, want] of Object.entries(rec.expect || {})) {
                const got = k.includes('.') ? getAt(skill, k) : { ok: Object.hasOwn(skill, k) || (want === null && skill[k] == null), value: skill[k] };
                const actual = k.includes('.') ? got.value : skill[k];
                const present = k.includes('.') ? got.ok : (want === null ? (skill[k] == null) : Object.hasOwn(skill, k));
                if (want === null) {
                    if (skill[k] != null) mismatches.push({ id: label, key: k, expect: null, actual: skill[k] });
                } else if (!present || !deepEqual(actual, want)) {
                    mismatches.push({ id: label, key: k, expect: want, actual });
                }
            }
            if (mismatches.some(m => m.id === label)) continue;
            for (const [k, v] of Object.entries(rec.set || {})) {
                const before = k.includes('.') ? getAt(skill, k).value : skill[k];
                if (k.includes('.')) setAt(skill, k, v); else skill[k] = v;
                changes.push({ id: label, op: 'set', target: `${rec.skill}.${k}`, before, after: v });
            }
            for (const k of rec.delete || []) {
                const before = skill[k];
                if (Object.hasOwn(skill, k) || skill[k] !== undefined) {
                    delete skill[k];
                    changes.push({ id: label, op: 'delete', target: `${rec.skill}.${k}`, before, after: undefined });
                } else {
                    changes.push({ id: label, op: 'delete-noop', target: `${rec.skill}.${k}`, before: undefined, after: undefined });
                }
            }
        } else if (rec.file === 'progress') {
            if (!Array.isArray(rec.path) || !rec.path.length) throw new Error(`${label}: progress record needs path[]`);
            const got = getAt(progress, rec.path);
            if (rec.expect !== undefined) {
                if (typeof rec.expect === 'object' && rec.expect !== null && !Array.isArray(rec.expect) && Object.keys(rec.expect).every(k => !k.includes('.'))) {
                    // expect is the whole value at path
                    if (!got.ok || !deepEqual(got.value, rec.expect)) {
                        mismatches.push({ id: label, key: rec.path.join('.'), expect: rec.expect, actual: got.ok ? got.value : undefined });
                        continue;
                    }
                }
            }
            if (rec.delete_path) {
                const before = got.ok ? got.value : undefined;
                if (!got.ok) {
                    mismatches.push({ id: label, key: rec.path.join('.'), expect: rec.expect, actual: undefined });
                    continue;
                }
                deletePath(progress, rec.path);
                changes.push({ id: label, op: 'delete_path', target: rec.path.join('.'), before, after: undefined });
            } else if (rec.set !== undefined) {
                throw new Error(`${label}: progress set-at-path not used in this manifest; use delete_path or extend the script`);
            }
        } else {
            throw new Error(`${label}: unknown file ${rec.file}`);
        }
    }

    if (mismatches.length) {
        const msg = mismatches.map(m => `  ${m.id} ${m.key}: expect ${JSON.stringify(m.expect)} got ${JSON.stringify(m.actual)}`).join('\n');
        throw new Error(`manifest expect mismatch (refusing to apply):\n${msg}`);
    }

    for (const c of changes) {
        log(`[reset-bug-poisoned] ${c.op} ${c.target}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`);
    }
    log(`[reset-bug-poisoned] ${changes.length} change(s) planned for bot under ${botsDir}`);

    if (!apply) {
        log('[reset-bug-poisoned] dry-run only (pass --apply to write)');
        return { changes, dryRun: true, indexPath, progressPath };
    }

    const ts = stamp();
    const backupDir = join(botsDir, 'skills', `backup-bug-poisoned-${ts}`);
    mkdirSync(backupDir, { recursive: true });
    const indexBak = join(backupDir, 'index.json');
    const progressBak = join(backupDir, 'progress.json');
    copyFileSync(indexPath, indexBak);
    copyFileSync(progressPath, progressBak);
    log(`[reset-bug-poisoned] backup: ${indexBak}`);
    log(`[reset-bug-poisoned] backup: ${progressBak}`);
    writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
    writeFileSync(progressPath, JSON.stringify(progress, null, 2) + '\n');
    log(`[reset-bug-poisoned] wrote ${indexPath}`);
    log(`[reset-bug-poisoned] wrote ${progressPath}`);
    return { changes, dryRun: false, indexPath, progressPath, backupDir };
}

function main() {
    const apply = arg('apply', false) === true;
    const manifestPath = resolve(arg('manifest', join(HERE, 'bug_poisoned_manifest.json')));
    const botsDir = resolve(arg('bots-dir', join(ROOT, 'bots', 'icefox2000')));
    const manifest = loadManifest(manifestPath);
    logBanner(manifest, botsDir, apply);
    applyManifest({ manifest, botsDir, apply });
}

function logBanner(manifest, botsDir, apply) {
    console.log(`[reset-bug-poisoned] manifest ${manifest.version} bot=${manifest.bot} records=${manifest.records.length}`);
    console.log(`[reset-bug-poisoned] bots-dir=${botsDir} mode=${apply ? 'APPLY' : 'dry-run'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); } catch (e) { console.error(`[reset-bug-poisoned] FAILED: ${e.message}`); process.exit(1); }
}
