// fix81: what it takes to obtain an item, from the game's own data only (no recipe, item or tool lists of ours).
//   recipes  - recipesOf(itemId): every recipe for the item (bot.recipesAll(id, null, true): all of them, not only the
//              ones the inventory can make now); ingredients and yield come from each recipe's delta / result
//   sources  - registry.blockLoot: the blocks whose loot yields the item without silk touch, and the block of that name
//   tools    - registry block harvestTools: a source block with harvestTools needs one of them held to drop anything
// An item with an acyclic recipe is crafted; one without is a raw resource, collected from a source block (or obtained
// some other way when no block yields it). Collecting from a block whose harvest tools are all missing needs a tool,
// which is planned the same way (the tool, then its ingredients, then theirs ...).
// A recipe whose expansion comes back to an item already being planned on that branch (iron_ingot -> iron_block ->
// iron_ingot) is a cycle in the game data: that recipe is excluded and the cycle is reported; nothing recurses on it.
// Options are compared by [opaque obtains (an unknown item no recipe or block in the data yields: what it takes cannot
// be read), units of raw resources with no known source, units of raw resources, steps]; "known" is learned or
// observed (a source block seen nearby, or a learned producer). Exact ties go to choose(tied).
export function obtainPlanner({ registry, recipesOf, known, choose }) {
    if (!registry) throw new Error('[fix81] obtainPlanner: registry required');
    if (typeof recipesOf !== 'function') throw new Error('[fix81] obtainPlanner: recipesOf(itemId) required');
    if (typeof known !== 'function') throw new Error('[fix81] obtainPlanner: known(item, sourceBlocks) required');
    if (typeof choose !== 'function') throw new Error('[fix81] obtainPlanner: choose(tied) required');
    if (!registry.blockLoot) throw new Error('[fix81] obtainPlanner: registry.blockLoot required');
    const itemName = id => {
        const it = registry.items[id];
        if (!it) throw new Error(`[fix81] recipe ingredient id ${id} is not an item in this registry`);
        return it.name;
    };
    const itemId = name => {
        const it = registry.itemsByName[name];
        if (!it) throw new Error(`[fix81] "${name}" is not an item in this registry`);
        return it.id;
    };
    const droppers = new Map();
    for (const [block, loot] of Object.entries(registry.blockLoot)) {
        for (const d of loot.drops) {
            if (d.silkTouch) continue;
            if (!droppers.has(d.item)) droppers.set(d.item, new Set());
            droppers.get(d.item).add(block);
        }
    }
    const sources = item => {
        const s = new Set(droppers.has(item) ? droppers.get(item) : []);
        if (registry.blocksByName[item]) s.add(item);
        return [...s];
    };
    // a block that is not an item (water, carrots ...) has no recipe in the game data; it can only be collected
    const recipes = item => (Object.hasOwn(registry.itemsByName, item) ? recipesOf(itemId(item)) : []).map(r => ({
        yield: r.result.count,
        ingredients: r.delta.filter(d => d.count < 0).map(d => ({ item: itemName(d.id), count: -d.count })),
    }));
    const has = (inv, item) => (Object.hasOwn(inv, item) ? inv[item] : 0);
    // the harvest tools a source of `item` needs, or null when some source drops it by hand or with a tool already held
    const toolsNeeded = (item, inv) => {
        const tools = new Set();
        for (const b of sources(item)) {
            const ht = registry.blocksByName[b].harvestTools;
            if (!ht) return null;
            const names = Object.keys(ht).map(id => itemName(Number(id)));
            if (names.some(t => has(inv, t) > 0)) return null;
            names.forEach(t => tools.add(t));
        }
        return [...tools];
    };
    const add = (a, b) => a.map((x, i) => x + b[i]);
    const less = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
    const pick = opts => {
        let best = [];
        for (const o of opts) {
            if (!best.length || less(o.cost, best[0].cost)) best = [o];
            else if (!less(best[0].cost, o.cost)) best.push(o);
        }
        if (!best.length) return null;
        return best.length === 1 ? best[0] : choose(best);
    };

    function plan(item, need, inv, path, ctx, gain) {
        // an ingredient that is already being planned on this branch is a cycle, even when the inventory holds it
        // (9 iron_ingot -> iron_block -> 9 iron_ingot makes nothing)
        if (path.includes(item)) { ctx.cycles.add([...path, item].join(' -> ')); return null; }
        const have = gain ? 0 : Math.min(has(inv, item), need);
        if (have) inv[item] -= have;
        const rem = need - have;
        if (rem === 0) return { cost: [0, 0, 0, 0], inv, steps: [], how: 'inventory' };
        const onPath = [...path, item];
        const crafts = [];
        for (const r of recipes(item)) {
            const times = Math.ceil(rem / r.yield);
            let sim = { ...inv }, cost = [0, 0, 0, 1];
            const steps = [], missing = [];
            let ok = true;
            for (const ing of r.ingredients) {
                const want = ing.count * times;
                const short = want - Math.min(has(sim, ing.item), want);
                const sub = plan(ing.item, want, sim, onPath, ctx, false);
                if (!sub) { ok = false; break; }
                if (short > 0) missing.push({ item: ing.item, count: short, how: sub.how });
                sim = sub.inv; cost = add(cost, sub.cost); steps.push(...sub.steps);
            }
            if (!ok) continue;
            sim[item] = has(sim, item) + times * r.yield - rem;
            steps.push({ verb: 'craft', item, count: rem });
            crafts.push({ cost, inv: sim, steps, how: 'craft', missing });
        }
        // raw: collected from a source block (its harvest tool planned the same way), or obtained some other way when no
        // block yields it — the latter only when the game data has no acyclic recipe or the item is known (learned/observed)
        const src = sources(item);
        const isKnown = known(item, src);
        const unknown = isKnown ? 0 : rem;
        const opts = [...crafts];
        if (src.length) {
            const tools = toolsNeeded(item, inv);
            if (!tools) opts.push({ cost: [0, unknown, rem, 1], inv, steps: [{ verb: 'collect', item, count: rem }], how: 'collect', missing: [] });
            else {
                const withTool = [];
                for (const t of tools) {
                    const sub = plan(t, 1, { ...inv }, onPath, ctx, false);
                    if (!sub) continue;
                    sub.inv[t] = has(sub.inv, t) + 1;   // a tool is kept, not consumed
                    withTool.push({ cost: add(sub.cost, [0, unknown, rem, 1]), inv: sub.inv, steps: [...sub.steps, { verb: 'collect', item, count: rem }], how: 'collect', tool: t, missing: [{ item: t, count: 1, how: sub.how }] });
                }
                if (!withTool.length) ctx.unobtainable.add(`${item} from ${src.join('/')} (needs one of ${tools.join(', ')}; none obtainable without a cycle)`);
                opts.push(...withTool);
            }
        } else if (!crafts.length || isKnown) opts.push({ cost: [isKnown ? 0 : 1, unknown, rem, 1], inv, steps: [{ verb: 'obtain', item, count: rem }], how: 'obtain', missing: [] });
        return pick(opts);
    }

    const taskFor = (how, item, count) => {
        if (how === 'craft') return `Craft ${count} ${item}`;
        if (how === 'collect') return `Collect ${count} ${item}`;
        if (how === 'obtain') return `Obtain ${count} ${item}`;
        throw new Error(`[fix81] taskFor: no task for how=${JSON.stringify(how)} (${count} ${item})`);
    };
    return {
        sources,
        toolsNeeded,
        // gain `count` more `item` starting from `inv`: how (craft / collect / obtain), the task for it, and its DIRECT
        // prerequisites (each one a subgoal that is planned again, the same way, when it runs). Throws when the game data
        // gives no acyclic way at all.
        prerequisites(item, count, inv) {
            if (!Number.isInteger(count)) throw new Error(`[fix81] prerequisites(${item}): integer count required, got ${JSON.stringify(count)}`);
            if (count < 1) throw new Error(`[fix81] prerequisites(${item}): count must be >= 1, got ${count}`);
            const ctx = { cycles: new Set(), unobtainable: new Set() };
            const best = plan(item, count, { ...inv }, [], ctx, true);
            const list = set => (set.size ? [...set].join('; ') : 'none');
            if (!best) throw new Error(`[fix81] LOUD: no acyclic way to obtain ${count} ${item} from the game data (cycles: ${list(ctx.cycles)}; unobtainable: ${list(ctx.unobtainable)})`);
            return {
                how: best.how,
                task: taskFor(best.how, item, count),
                tool: Object.hasOwn(best, 'tool') ? best.tool : null,
                steps: best.missing.map(m => ({ item: m.item, count: m.count, task: taskFor(m.how, m.item, m.count) })),
                plan: best.steps.map(s => taskFor(s.verb, s.item, s.count)),
                cycles: [...ctx.cycles],
            };
        },
    };
}
