// fix47: shared prompt utilities (deduplicated from voyager.js and coder.js)

// Per-prompt breakdown logging for code model and curriculum calls
// Logs section sizes to help diagnose prompt bloat
// fix96: `sent` (optional) is the length of the text actually sent; the part no section names is logged as framing,
// so the total is the real prompt and not the sum of the sections someone remembered to list.
export function logPromptBreakdown(kind, sections, sent) {
    for (const [k, v] of Object.entries(sections)) {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`[fix96] prompt section ${k} size must be a non-negative integer, got ${JSON.stringify(v)}`);
    }
    const counted = Object.values(sections).reduce((a, b) => a + b, 0);
    const parts = Object.entries(sections).map(([k, v]) => `${k}=${v}`);
    if (sent === undefined) {
        console.log(`[prompt] kind=${kind} total=${counted} chars: ${parts.join(' ')}`);
        return counted;
    }
    if (typeof sent !== 'number' || !Number.isInteger(sent) || sent < counted) {
        throw new Error(`[fix96] ${kind} prompt sent ${JSON.stringify(sent)} chars but its sections add up to ${counted}`);
    }
    parts.push(`framing=${sent - counted}`);
    console.log(`[prompt] kind=${kind} total=${sent} chars: ${parts.join(' ')}`);
    return sent;
}

// Extract bare function calls from code (skill or generated)
// Returns array of camelCase function names called directly (not via object.method)
export function extractBareCalls(code) {
    const src = String(code).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const calls = new Set();
    const re = /(?<![.\w])([a-z][A-Za-z0-9]*)\s*\(/g;
    let m;
    while ((m = re.exec(src))) calls.add(m[1]);
    return [...calls];
}
