import { itemSourceBlocks } from '../utils/item_sources.js';
import { furnaceInputsOf, fuelItemNames } from './furnace_recipes.js';

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
// observed (a source block seen nearby, or a learned producer). A raw resource's cost includes its harvest tool, planned
// recursively from block.harvestTools (stone_pickaxe needs cobblestone, whose blocks need a pickaxe), unless a held tool
// works. Exact cost ties are not a choice to randomise: the option with fewer untried (not run-proven) edges wins, then
// the lexically first option name; each tie broken is reported (ties) and logged by the caller.
// fix96: an option's raw units are EXPECTED units: the count over the expected yield of one source (the loot's mean stack
// size; the block of the item's own name yields 1; entity loot the same way) and over the observed success of the item's
// producer edge (progress.recipeEdges runs/fails, posterior (s+1)/(n+2), 1 before any failure). A raw count alone made
// "Collect 1 apple" (oak_leaves nearby, 86 of 86 runs failed) the cheapest food every time. The data's dropChance is not
// used (see meanDrop); what a source really yields is learned from the runs.
// fix96: entity loot (registry.entityLoot) is a source of an item no recipe or block yields (beef from a cow): that option
// is "obtain" from the named entities, not opaque.
// fix142 (live icefox2000, 18 Nov): an entity-obtain rendered as "Obtain N <item>" routes to the generic obtainItem skill,
// which tried craftRecipe(chicken) ("No recipe for chicken" — mobs drop items on death, they are not crafted; the obtain
// verb never reached killMob/goToMob). The task for an entity-obtain is now "Kill N <dropper>" (highest expected yield,
// name order on ties — deterministic), which routes to killMob and, through its fix141 mob contract, chains "approach <mob>"
// when none is near. Opaque obtains (no recipe, block, entity, or furnace source) keep "Obtain N <item>". Learned smelt edges (smeltInputs(item): the inputs of "Smelt N <in>
// into N <item>" goals that succeeded) plan the input, then the smelt.
// fix97: furnace recipes come from minecraft-data (PC recipes.json has no furnace type; the package's bedrock furnace
// tables name the same items). A smelt plans its input, a furnace, and a fuel. The fuel is the cheapest of the Java
// names for logs, wood, planks, coal, and charcoal (legacy bedrock names mapped through minecraft-data), using what
// is held, nearby, or proven. An item no recipe, block, entity, or furnace recipe yields is an opaque obtain (egg,
// milk_bucket): feasible only when that obtain is known or proven, so the food raiser does not queue it. When
// `feasible` is true, a collect counts only when a source block is present or a producer edge is proven.
// fix205: the lexicographic order over plan cost vectors [opaque obtains, raw units with no known source,
// raw units, steps]. lessCost(a, b) is true only when a is strictly cheaper. pick() inside the planner and the
// food ranking outside it (food_backchain.planFoodAcquisition) share this one comparator.
export function lessCost(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) throw new Error(`[fix205] lessCost needs two cost vectors, got ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
    if (a.length !== b.length) throw new Error(`[fix205] LOUD: cost vectors differ in length: ${a.length} vs ${b.length}`);
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
}

export function obtainPlanner({ registry, recipesOf, known, proven, edgeSuccess, smeltInputs, present, mobSighted }) {
    if (!registry) throw new Error('[fix81] obtainPlanner: registry required');
    if (typeof recipesOf !== 'function') throw new Error('[fix81] obtainPlanner: recipesOf(itemId) required');
    if (typeof known !== 'function') throw new Error('[fix81] obtainPlanner: known(item, sourceBlocks) required');
    if (typeof proven !== 'function') throw new Error('[fix81] obtainPlanner: proven(item) required (a run-proven producer edge)');
    if (typeof edgeSuccess !== 'function') throw new Error('[fix96] obtainPlanner: edgeSuccess(item, verb) required (observed success of a producer edge)');
    if (typeof smeltInputs !== 'function') throw new Error('[fix96] obtainPlanner: smeltInputs(item) required (learned smelt edges)');
    if (typeof present !== 'function') throw new Error('[fix97] obtainPlanner: present(block) required (a source block observed nearby)');
    // fix175: world-absence is a world fact, same rule the task gate applies (voyager "never been
    // sighted in this world"). A mob nobody has sighted is not a source in THIS world even though
    // game-data loot lists it (live 23 Nov: hunger planned "Kill 1 hoglin" from stale world memory;
    // the gate rejected it every step in a tight loop with the urgent-need re-planner).
    if (typeof mobSighted !== 'function') throw new Error('[fix175] obtainPlanner: mobSighted(entity) required (has this mob been seen in this world)');
    if (registry.entityLoot === undefined || registry.entityLoot === null) throw new Error('[fix96] obtainPlanner: registry.entityLoot required');
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
    // fix96: the same source list the search uses (fix95 itemSourceBlocks): a loot key that is not a block in this registry
    // (1.20.4 keeps "grass") is not a source; it used to reach toolsNeeded and read blocksByName["grass"].harvestTools.
    const sourceMemo = new Map();   // game data does not change while a planner lives
    const sources = item => {
        if (!sourceMemo.has(item)) sourceMemo.set(item, itemSourceBlocks(registry, item));
        return [...sourceMemo.get(item)];
    };
    // The data's dropChance is not a probability the bot can use: 1.20.4 minecraft-data gives apple from oak_leaves 1 (the game:
    // 0.5%), oak_sapling 0.5, and splits every silk-touch / no-silk-touch alternative 0.5 / 0.5 (raw_iron from iron_ore 0.5,
    // though without silk touch it always drops). Read as a chance, it made raw_iron cheaper to craft from a raw_iron_block
    // than to mine. The prior is the stack size only; the observed edge success (below) is what measures the chance.
    const meanDrop = (d, where) => {
        const r = d.stackSizeRange;
        if (!Array.isArray(r) || r.length !== 2) throw new Error(`[fix96] ${where} drop ${d.item}: stackSizeRange [min, max] required, got ${JSON.stringify(r)}`);
        // 1.20.4 data leaves one bound null on three drops (melon [null,1], mushroom blocks [0,null]): the stated bounds
        // are what is known; a drop with no positive stated bound adds no expected yield (null: the caller skips it).
        const stated = r.filter(x => typeof x === 'number');
        if (stated.length === 0) return null;
        const mean = stated.reduce((a, b) => a + b, 0) / stated.length;
        return mean > 0 ? mean : null;
    };
    // expected items per source broken: the best source (the collect goes to whichever source is found)
    const blockYield = item => {
        let best = 0;
        for (const b of sources(item)) {
            if (b === item) { best = Math.max(best, 1); continue; }
            for (const d of registry.blockLoot[b].drops) {
                if (d.item !== item || d.silkTouch) continue;
                const y = meanDrop(d, `blockLoot ${b}`);
                if (y !== null) best = Math.max(best, y);
            }
        }
        if (!(best > 0)) throw new Error(`[fix96] LOUD: ${item} has sources ${sources(item).join(', ')} but no positive expected drop`);
        return best;
    };
    const entityEntries = Array.isArray(registry.entityLoot) ? registry.entityLoot : Object.values(registry.entityLoot);
    const entityMemo = new Map();
    const entitySources = item => {
        if (!entityMemo.has(item)) entityMemo.set(item, entityDropsOf(item));
        return entityMemo.get(item);
    };
    const entityDropsOf = item => {
        const out = [];
        for (const e of entityEntries) {
            if (!e || typeof e.entity !== 'string' || !Array.isArray(e.drops)) throw new Error(`[fix96] entityLoot entry is malformed: ${JSON.stringify(e)}`);
            // fix175: an unseen mob is not a source in this world (see the mobSighted option).
            if (!mobSighted(e.entity)) continue;
            for (const d of e.drops) {
                if (d.item !== item) continue;
                const y = meanDrop(d, `entityLoot ${e.entity}`);
                if (y !== null) out.push({ entity: e.entity, yield: y });
            }
        }
        // fix142: deterministic order (expected yield descending, entity name ascending): the first entry is the dropper
        // the Kill task names.
        out.sort((a, b) => (b.yield !== a.yield ? b.yield - a.yield : (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0)));
        return out;
    };
    // fix198: sapling -> log. minecraft-data models this nowhere (growth is not a recipe), but the registry's names
    // are the canonical mapping: <p>_sapling is placed on soil and grows into <p>_log, and bone meal grows it
    // instantly (minecraft.wiki/w/Sapling, minecraft.wiki/w/Bone_Meal). A bot holding saplings and bone meal can
    // grow wood where no tree is reachable (live 25 Nov: icefox entombed at y33 holding birch_sapling + bone_meal
    // with no path to any log source).
    const growthSourceMemo = new Map();
    const growthSource = item => {
        if (!growthSourceMemo.has(item)) {
            let sapling = null;
            if (item.endsWith('_log') && Object.hasOwn(registry.itemsByName, item)) {
                const cand = `${item.slice(0, -'_log'.length)}_sapling`;
                if (Object.hasOwn(registry.itemsByName, cand)) sapling = cand;
            }
            growthSourceMemo.set(item, sapling);
        }
        return growthSourceMemo.get(item);
    };
    const success = (item, verb) => {
        const p = edgeSuccess(item, verb);   // verb null: the item's edge, whatever its verb
        if (typeof p !== 'number' || !(p > 0) || p > 1) throw new Error(`[fix96] edgeSuccess(${item}, ${verb}) must be in (0, 1], got ${JSON.stringify(p)}`);
        return p;
    };
    // expected units: count / (yield per source x observed success of the edge)
    const expected = (rem, perSource, item, verb) => rem / (perSource * success(item, verb));
    // a block that is not an item (water, carrots ...) has no recipe in the game data; it can only be collected.
    // fix100: recipes do not change while a planner lives (same rule as sourceMemo). plan() asked for them on every node.
    const recipeMemo = new Map();
    const recipes = item => {
        if (!recipeMemo.has(item)) {
            const found = Object.hasOwn(registry.itemsByName, item) ? recipesOf(itemId(item)) : [];
            recipeMemo.set(item, found.map(r => ({
                yield: r.result.count,
                ingredients: r.delta.filter(d => d.count < 0).map(d => ({ item: itemName(d.id), count: -d.count })),
            })));
        }
        return recipeMemo.get(item);
    };
    const has = (inv, item) => (Object.hasOwn(inv, item) ? inv[item] : 0);
    // Java fuels (logs, wood, planks, coal, charcoal). Legacy names are mapped in fuelItemNames, not listed here.
    const fuelNames = fuelItemNames(registry);
    const reachableCollect = (item, src) => src.some(block => present(block) === true) || proven(item) === true;
    // One furnace plan and one fuel plan per inventory. A smelt does not consume the item it smelts, so every food shares
    // them. Nested smelts (the furnace's own ingredients) do not plan a second furnace: that is the same cycle the path
    // used to cut, and it is what made choosing among every food replan the tool chain once per food.
    const invKey = inv => {
        const keys = Object.keys(inv).filter(k => inv[k]);
        keys.sort();
        return keys.map(k => k + '=' + inv[k]).join(',');
    };
    const clonePlan = p => {
        if (p === null) return null;
        const out = { ...p, inv: { ...p.inv }, steps: p.steps.map(s => ({ ...s })), ingredients: p.ingredients.map(i => ({ ...i })) };
        if (Array.isArray(p.missing)) out.missing = p.missing.map(m => ({ ...m }));
        if (Array.isArray(p.from)) out.from = [...p.from];
        return out;
    };
    const fuelMemo = new Map();
    // A craft is an AND of its ingredients; a smelt is an AND of (input, furnace, fuel); the recipes, furnace
    // inputs, and collect/obtain options for one item are an OR. cheapest() asks for that graph once per food,
    // and each food walks it again. Memoising the solved node is how AND/OR graph search avoids expanding the
    // same node again (Nilsson, Principles of Artificial Intelligence, 1980; Martelli and Montanari, "Additive
    // AND/OR Graphs", IJCAI 1973). GOAP keys the search the same way, on the world state (Orkin, "Applying
    // Goal-Oriented Action Planning to Games", AI Game Programming Wisdom 2, 2003).
    // The key is that world state: the item, the count still needed, the inventory, whether held stock of the
    // item counts, and whether infeasible options are dropped. The branch is not in the key. path.includes
    // cuts a cycle before the lookup, so iron_ingot is not solved as a member of its own branch
    // (iron_ingot -> iron_block -> iron_ingot). Solving the same state again on the next branch was the
    // fan-out: a smelt plans every furnace input, charcoal's inputs are every log, and each log was expanded
    // again per branch (2.8M expansions, 6–8 s). A state already on the stack — fuel asked for while that
    // fuel's own plan is running — is a cycle as well; the lookup returns null and the outer solve is stored.
    const planMemo = new Map();
    const PLANNING = Object.freeze({ planning: true });
    let planCalls = 0;
    function planStateKey(item, need, inv, feasible, gain) {
        return item + '\0' + need + '\0' + (gain ? '1' : '0') + '\0' + (feasible ? '1' : '0') + '\0' + invKey(inv);
    }
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
    const less = lessCost;   // fix205: one comparator module-wide
    // an option's name: its steps (or the item, for a choice between items); its untried edges: steps not proven by a run
    const optName = o => (Object.hasOwn(o, 'item') ? o.item : o.steps.map(st => `${st.verb} ${st.item}`).join(' > '));
    const untried = o => o.steps.filter(st => !proven(st.item)).length;
    const pick = (opts, ctx, what) => {
        let best = [];
        for (const o of opts) {
            if (!best.length || less(o.cost, best[0].cost)) best = [o];
            else if (!less(best[0].cost, o.cost)) best.push(o);
        }
        if (!best.length) return null;
        if (best.length === 1) return best[0];
        const ranked = best.map(o => ({ o, u: untried(o), n: optName(o) }))
            .sort((a, b) => (a.u !== b.u ? a.u - b.u : (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)));
        ctx.ties.add(`${what} [cost ${ranked[0].o.cost.join(',')}]: "${ranked[0].n}" (${ranked[0].u} untried) over ${ranked.slice(1).map(r => `"${r.n}" (${r.u} untried)`).join(', ')}`);
        return ranked[0].o;
    };

    function planFurnace(inv, ctx) {
        if (!Object.hasOwn(registry.itemsByName, 'furnace')) throw new Error('[fix97] registry has no furnace item');
        return plan('furnace', 1, { ...inv }, [], ctx, false);
    }
    function planFuel(inv, ctx, path) {
        const key = (ctx.feasible === true ? '1' : '0') + '\0' + invKey(inv);
        const hit = fuelMemo.get(key);
        if (hit === PLANNING) return null;
        if (hit !== undefined) {
            if (!hit) return null;
            if (path.includes(hit.fuelItem)) return null;
            return clonePlan(hit);
        }
        if (!fuelNames.length) throw new Error('[fix97] LOUD: no fuel item exists in this registry, so a smelt has no fuel');
        fuelMemo.set(key, PLANNING);
        // A held fuel is an inventory plan (cost 0), which is cheaper than any obtain. Same order as cheapest.
        const held = fuelNames.filter(name => has(inv, name) > 0);
        const candidates = held.length ? held : fuelNames;
        const opts = [];
        for (const name of candidates) {
            const sub = plan(name, 1, { ...inv }, [], ctx, false);
            if (!sub) continue;
            if (ctx.feasible === true && sub.feasible !== true) continue;
            sub.fuelItem = name;
            opts.push({ cost: sub.cost, item: name, steps: sub.steps, plan: sub });
        }
        const best = pick(opts, ctx, 'fuel');
        const chosen = best ? best.plan : null;
        fuelMemo.set(key, clonePlan(chosen));
        if (!chosen) return null;
        if (typeof chosen.fuelItem !== 'string' || chosen.fuelItem.length === 0) throw new Error('[fix97] LOUD: fuel plan has no fuel item');
        if (path.includes(chosen.fuelItem)) return null;
        return chosen;
    }
    function plan(item, need, inv, path, ctx, gain) {
        // an ingredient that is already being planned on this branch is a cycle, even when the inventory holds it
        // (9 iron_ingot -> iron_block -> 9 iron_ingot makes nothing)
        if (path.includes(item)) { ctx.cycles.add([...path, item].join(' -> ')); return null; }
        const key = planStateKey(item, need, inv, ctx.feasible === true, gain);
        const hit = planMemo.get(key);
        if (hit === PLANNING) return null;
        if (hit !== undefined) return clonePlan(hit);
        planCalls += 1;
        planMemo.set(key, PLANNING);
        let planned;
        try {
            planned = expandPlan(item, need, inv, path, ctx, gain);
        } catch (err) {
            planMemo.delete(key);
            throw err;
        }
        planMemo.set(key, clonePlan(planned));
        return planned;
    }
    function expandPlan(item, need, inv, path, ctx, gain) {
        const have = gain ? 0 : Math.min(has(inv, item), need);
        if (have) inv[item] -= have;
        const rem = need - have;
        if (rem === 0) return { cost: [0, 0, 0, 0], inv, steps: [], how: 'inventory', ingredients: [], feasible: true };
        const onPath = [...path, item];
        const crafts = [];
        for (const r of recipes(item)) {
            const times = Math.ceil(rem / r.yield);
            let sim = { ...inv }, cost = [0, 0, 0, 1];
            const steps = [], missing = [];
            let ok = true, feasible = true;
            for (const ing of r.ingredients) {
                const want = ing.count * times;
                const short = want - Math.min(has(sim, ing.item), want);
                const sub = plan(ing.item, want, sim, onPath, ctx, false);
                if (!sub) { ok = false; break; }
                if (sub.feasible !== true) feasible = false;
                if (short > 0) missing.push({ item: ing.item, count: short, how: sub.how, input: sub.input, from: sub.from });
                sim = sub.inv; cost = add(cost, sub.cost); steps.push(...sub.steps);
            }
            if (!ok) continue;
            if (ctx.feasible === true && !feasible) continue;
            sim[item] = has(sim, item) + times * r.yield - rem;
            steps.push({ verb: 'craft', item, count: rem });
            crafts.push({ cost, inv: sim, steps, how: 'craft', missing, ingredients: r.ingredients.map(ing => ({ item: ing.item, count: ing.count * times })), feasible });
        }
        // raw: collected from a source block (its harvest tool planned the same way), or obtained some other way when no
        // block yields it — the latter only when the game data has no acyclic recipe or the item is known (learned/observed)
        const src = sources(item);
        // fix96: a producer edge that ran and never succeeded is not a known way to get the item (86 of 86 apple runs failed
        //        with oak_leaves in sight); its expected units count as unknown until a run succeeds.
        const failing = proven(item) === false && success(item, null) < 1;
        const isKnown = known(item, src) && !failing;
        const opts = [...crafts];
        // furnace recipes (game data) and learned smelt edges: plan the input, a furnace, and a fuel, then the smelt
        const learnedIns = smeltInputs(item);
        if (!Array.isArray(learnedIns)) throw new Error(`[fix96] smeltInputs(${item}) must return an array`);
        const ins = [];
        for (const input of [...furnaceInputsOf(item).filter(name => Object.hasOwn(registry.itemsByName, name)), ...learnedIns]) {
            if (input === item || path.includes(input) || ins.includes(input)) continue;
            ins.push(input);
        }
        for (const input of ins) {
            const sub = plan(input, rem, { ...inv }, onPath, ctx, false);
            if (!sub) continue;
            const furnace = path.includes('furnace') ? null : planFurnace(inv, ctx);
            if (!furnace) continue;
            const fuel = planFuel(inv, ctx, path);
            if (!fuel) continue;
            if (ctx.feasible === true && (sub.feasible !== true || furnace.feasible !== true || fuel.feasible !== true)) continue;
            const units = expected(rem, 1, item, 'smelt') - rem;   // the input's own units are in sub.cost; this adds the edge's failures
            const missing = [];
            if (rem - Math.min(has(inv, input), rem) > 0) missing.push({ item: input, count: rem - Math.min(has(inv, input), rem), how: sub.how, input: sub.input, from: sub.from });
            if (furnace.steps.length) missing.push({ item: 'furnace', count: 1, how: furnace.how, input: furnace.input });
            if (fuel.steps.length) {
                const got = fuel.steps[fuel.steps.length - 1];
                missing.push({ item: got.item, count: got.count, how: got.verb, input: got.input });
            }
            opts.push({
                cost: add(add(add(sub.cost, furnace.cost), fuel.cost), [0, units, units, 1]),
                inv: sub.inv,
                steps: [...sub.steps, ...furnace.steps, ...fuel.steps, { verb: 'smelt', item, count: rem, input }],
                how: 'smelt',
                input,
                fuelItem: fuel.fuelItem,
                missing,
                ingredients: [{ item: input, count: rem }, ...furnace.ingredients, ...fuel.ingredients],
                feasible: true,
            });
        }
        // fix198: tree growth, an OR next to collecting the log (see growthSource above). The saplings are
        // subplanned the way a smelt subplans its input; the bone meal is deliberately NOT subplanned.
        // Its acquisition chain (bone_meal -> bone_block -> pickaxe-tool collects -> planks -> stick ->
        // back into the very log being grown) re-enters the wood graph under every log plan, and the
        // cycle-pruned subplan results leak through the shared plan memo: fix81's iron_pickaxe began
        // planning as stone_pickaxe once grow landed (a path-pruned stick served to a path-free query).
        // Bone meal is modeled at inventory level instead: held, or one bone_block craft away
        // (minecraft.wiki/w/Bone_Meal). Growing and chopping happen at the bot's own spot, so the option
        // is feasible whenever its ingredients are.
        const sapling = growthSource(item);
        if (sapling && Object.hasOwn(registry.itemsByName, 'bone_meal')) {
            // gate on the bone meal FIRST: no sapling plan can create a bone product, so checking the
            // inventory before subplanning keeps every wood plan that lacks bone meal one `has` call
            // away from HEAD's search size (fix100 watchdog budget).
            let meal = null;
            if (has(inv, 'bone_meal') >= 1) meal = { cost: [0, 0, 0, 0], steps: [], delta: {} };
            else {
                const r = recipes('bone_meal').find(rr => rr.ingredients.every(ing => has(inv, ing.item) >= ing.count));
                if (r) {
                    const delta = { bone_meal: r.yield };
                    for (const ing of r.ingredients) delta[ing.item] = (delta[ing.item] || 0) - ing.count;
                    meal = { cost: [0, 1, 1, 1], steps: [{ verb: 'craft', item: 'bone_meal', count: 1 }], delta };
                }
            }
            if (meal) {
                const subS = plan(sapling, rem, { ...inv }, onPath, ctx, false);
                if (subS && !(ctx.feasible === true && subS.feasible !== true)) {
                    const units = expected(rem, 1, item, 'collect') - rem;   // one sapling grows one trunk; the sapling's own units are in subS.cost
                    const missing = [];
                    if (rem - Math.min(has(inv, sapling), rem) > 0) missing.push({ item: sapling, count: rem - Math.min(has(inv, sapling), rem), how: subS.how, input: subS.input, from: subS.from });
                    const sim = { ...subS.inv };
                    for (const [k, d] of Object.entries(meal.delta)) sim[k] = has(sim, k) + d;
                    opts.push({
                        cost: add(add(subS.cost, meal.cost), [0, units, units, 1]),
                        inv: sim,
                        steps: [...subS.steps, ...meal.steps, { verb: 'grow', item, count: rem, input: sapling }],
                        how: 'grow',
                        input: sapling,
                        missing,
                        ingredients: [{ item: sapling, count: rem }, { item: 'bone_meal', count: 1 }],
                        feasible: true,
                    });
                }
            }
        }
        if (src.length) {
            const reachable = reachableCollect(item, src);
            if (!(ctx.feasible === true && !reachable)) {
                const units = expected(rem, blockYield(item), item, 'collect');
                const unknown = isKnown ? 0 : units;
                const tools = toolsNeeded(item, inv);
                if (!tools) opts.push({ cost: [0, unknown, units, 1], inv, steps: [{ verb: 'collect', item, count: rem }], how: 'collect', missing: [], ingredients: [], feasible: reachable });
                else {
                    const withTool = [];
                    for (const t of tools) {
                        const sub = plan(t, 1, { ...inv }, onPath, ctx, false);
                        if (!sub) continue;
                        if (ctx.feasible === true && sub.feasible !== true) continue;
                        sub.inv[t] = has(sub.inv, t) + 1;   // a tool is kept, not consumed
                        withTool.push({ cost: add(sub.cost, [0, unknown, units, 1]), inv: sub.inv, steps: [...sub.steps, { verb: 'collect', item, count: rem }], how: 'collect', tool: t, missing: [{ item: t, count: 1, how: sub.how, input: sub.input }], ingredients: [], feasible: reachable });
                    }
                    if (!withTool.length) ctx.unobtainable.add(`${item} from ${src.join('/')} (needs one of ${tools.join(', ')}; none obtainable without a cycle)`);
                    opts.push(...withTool);
                }
            }
        } else {
            const mobs = entitySources(item);
            if (mobs.length) {
                const best = mobs[0].yield;   // fix142: entitySources is ranked (yield desc, name asc)
                const units = expected(rem, best, item, 'obtain');
                opts.push({ cost: [0, isKnown ? 0 : units, units, 1], inv, steps: [{ verb: 'obtain', item, count: rem, from: mobs.map(m => m.entity) }], how: 'obtain', from: mobs.map(m => m.entity), missing: [], ingredients: [], feasible: true });
            } else if (recipes(item).length === 0 && furnaceInputsOf(item).length === 0) {
                // No crafting recipe, block, mob drop, or furnace recipe (egg, milk_bucket). A cycle that
                // emptied `crafts` still has recipes, so it is not this option. Unknown obtains are not
                // feasible, so the food raiser does not queue them.
                const feasible = isKnown || proven(item) === true;
                if (!(ctx.feasible === true && !feasible)) {
                    opts.push({ cost: [isKnown ? 0 : 1, isKnown ? 0 : rem, rem, 1], inv, steps: [{ verb: 'obtain', item, count: rem }], how: 'obtain', missing: [], ingredients: [], feasible });
                }
            }
        }
        return pick(opts, ctx, item);
    }

    const taskFor = (how, item, count, input, from) => {
        if (how === 'smelt') {
            if (typeof input !== 'string' || input.length === 0) throw new Error(`[fix96] taskFor: a smelt of ${item} needs its input`);
            return `Smelt ${count} ${input} into ${count} ${item}`;
        }
        if (how === 'grow') {
            if (typeof input !== 'string' || input.length === 0) throw new Error(`[fix198] taskFor: a grow of ${item} needs its sapling`);
            return `Grow ${count} ${item} from ${count} ${input}`;
        }
        if (how === 'craft') return `Craft ${count} ${item}`;
        if (how === 'collect') return `Collect ${count} ${item}`;
        if (how === 'obtain') {
            // fix142: a mob-dropped item is obtained by killing its dropper (routes to killMob, fix141 chains approach)
            if (Array.isArray(from) && from.length) return `Kill ${count} ${from[0]}`;
            return `Obtain ${count} ${item}`;
        }
        throw new Error(`[fix81] taskFor: no task for how=${JSON.stringify(how)} (${count} ${item})`);
    };
    return {
        sources,
        toolsNeeded,
        // expansions of plan(), not cache hits. cheapest() of every food is one AND/OR search.
        planCalls() { return planCalls; },
        // gain `count` more `item` starting from `inv`: how (craft / collect / obtain), the task for it, and its DIRECT
        // prerequisites (each one a subgoal that is planned again, the same way, when it runs). Throws when the game data
        // gives no acyclic way at all.
        prerequisites(item, count, inv) {
            if (!Number.isInteger(count)) throw new Error(`[fix81] prerequisites(${item}): integer count required, got ${JSON.stringify(count)}`);
            if (count < 1) throw new Error(`[fix81] prerequisites(${item}): count must be >= 1, got ${count}`);
            const ctx = { cycles: new Set(), unobtainable: new Set(), ties: new Set() };
            const best = plan(item, count, { ...inv }, [], ctx, true);
            const list = set => (set.size ? [...set].join('; ') : 'none');
            if (!best) {
                // fix183: structured so the reach-need chain (voyager _subgoalForNeed) can tell "no way from this
                // world state" (search for the block instead) from a planner bug (which must propagate).
                const err = new Error(`[fix81] LOUD: no acyclic way to obtain ${count} ${item} from the game data (cycles: ${list(ctx.cycles)}; unobtainable: ${list(ctx.unobtainable)})`);
                err.noAcyclicWay = true;
                throw err;
            }
            if (!Array.isArray(best.ingredients)) throw new Error(`[fix92] plan for ${item} has no direct ingredient list`);
            return {
                how: best.how,
                task: taskFor(best.how, item, count, best.input, best.from),
                tool: Object.hasOwn(best, 'tool') ? best.tool : null,
                from: Object.hasOwn(best, 'from') ? best.from : [],
                ingredients: best.ingredients,
                steps: best.missing.map(m => ({ item: m.item, count: m.count, task: taskFor(m.how, m.item, m.count, m.input, m.from) })),
                plan: best.steps.map(s => taskFor(s.verb, s.item, s.count, s.input, s.from)),
                cycles: [...ctx.cycles],
                ties: [...ctx.ties],
                cost: best.cost,
                fuel: Object.hasOwn(best, 'fuelItem') ? best.fuelItem : null,
            };
        },
        // the one of `items` that is cheapest to gain `count` of from `inv` (a need that any of several items meets:
        // a harvest tool tier, a storage block); exact ties as in pick (proven edges, then name), reported in ties.
        // Throws when none of them can be obtained.
        cheapest(items, count, inv, feasible) {
            if (typeof feasible !== 'boolean') throw new Error('[fix97] cheapest: feasible (true or false) required');
            const opts = [], ctx = { cycles: new Set(), unobtainable: new Set(), ties: new Set(), feasible };
            for (const item of items) {
                const best = plan(item, count, { ...inv }, [], { cycles: new Set(), unobtainable: new Set(), ties: new Set(), feasible }, true);
                if (best) opts.push({ cost: best.cost, item, steps: best.steps });
            }
            const best = pick(opts, ctx, `one of ${items.join('/')}`);
            if (best === null) {
                if (feasible) throw new Error(`[fix97] LOUD: none of ${items.join(', ')} is reachable from the inventory, nearby blocks, entity loot, furnace recipes, and proven edges`);
                throw new Error(`[fix81] LOUD: none of ${items.join(', ')} can be obtained from the game data`);
            }
            return { item: best.item, ties: [...ctx.ties], plan: best.steps ? best.steps.map(s => taskFor(s.verb, s.item, s.count, s.input, s.from)) : [] };
        },
        // fix205: the cost vector of gaining `count` more `item` from `inv` under the `feasible` rule, or null when
        // the game data gives no way. Probing each food at the unit count its own food value needs is how the food
        // chain ranks candidates by cost-to-close-the-deficit instead of cost-per-item.
        cost(item, count, inv, feasible) {
            if (typeof feasible !== 'boolean') throw new Error('[fix205] cost: feasible (true or false) required');
            if (!Number.isInteger(count) || count < 1) throw new Error(`[fix205] cost(${item}): count must be an integer >= 1, got ${JSON.stringify(count)}`);
            const best = plan(item, count, { ...inv }, [], { cycles: new Set(), unobtainable: new Set(), ties: new Set(), feasible }, true);
            return best ? best.cost : null;
        },
    };
}
