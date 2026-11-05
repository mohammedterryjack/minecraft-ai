// fix47: shared prompt utilities (deduplicated from voyager.js and coder.js)

// Per-prompt breakdown logging for code model and curriculum calls
// Logs section sizes to help diagnose prompt bloat
export function logPromptBreakdown(kind, sections) {
    const total = Object.values(sections).reduce((a, b) => a + b, 0);
    const breakdown = Object.entries(sections).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`[prompt] kind=${kind} total=${total} chars: ${breakdown}`);
    return total;
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
