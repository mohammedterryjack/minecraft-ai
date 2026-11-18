// fix144 probe: token-level scan of every live skill code field (read-only).
// Verifies (a) every field tokenizes, (b) what the token-aware scan reports vs the raw regex.
import { readFileSync } from 'node:fs';
import * as acorn from 'acorn';

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const skills = Array.isArray(data) ? data : data.skills;
const LEFT = /\b(?:skills|world)\.\w+/;

function prefixedRefs(value) {
    const hits = [];
    let t0 = null, t1 = null, t2 = null;
    for (const tk of acorn.tokenizer(value, { ecmaVersion: 'latest' })) {
        if (t2 && t1 && t2.type.label === '.' && t1.type.label === 'name'
            && (t1.value === 'skills' || t1.value === 'world') && tk.type.label === 'name'
            && !(t0 && t0.type.label === '.')) {
            hits.push(`${t1.value}.${tk.value}`);
        }
        t0 = t1; t1 = t2; t2 = tk;
    }
    return hits;
}

function fields(s) {
    const out = [];
    if (s.code) out.push(['code', s.code]);
    for (const k of ['candidate', 'prev', 'handwritten_original']) {
        if (typeof s[k] === 'object' && s[k] && s[k].code) out.push([`${k}.code`, s[k].code]);
    }
    (s.variants || []).forEach((v, i) => { if (v && v.code) out.push([`variants[${i}].code`, v.code]); });
    (s.repairHistory || []).forEach((rh, i) => {
        if (rh && rh.code) out.push([`repairHistory[${i}].code`, rh.code]);
        if (rh && rh.fixSnippet) out.push([`repairHistory[${i}].fixSnippet`, rh.fixSnippet]);
    });
    return out;
}

let tokFail = 0, regexHits = 0, tokHits = 0;
for (const s of skills) {
    for (const [p, v] of fields(s)) {
        const rp = `${s.name}.${p}`;
        const rx = LEFT.test(v);
        let tx = null;
        try { tx = prefixedRefs(v); } catch (e) { console.log(`TOKENIZE-FAIL ${rp}: ${e.message}`); tokFail++; continue; }
        if (rx) { regexHits++; if (!tx.length) console.log(`regex-only (comment/string): ${rp} raw=${JSON.stringify(v.match(new RegExp(LEFT.source), 'g'))}`); }
        if (tx.length) { tokHits++; console.log(`TOKEN HIT ${rp}: ${tx.join(', ')}`); }
    }
}
console.log(`entries=${skills.length} tokenize_fail=${tokFail} regex_hits=${regexHits} token_hits=${tokHits}`);
