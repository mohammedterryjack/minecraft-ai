// fix114: memoize bot.pathfinder.bestHarvestTool for the whole world-exhaust search.
//
// Root cause of the memory growth (live 2026-11-15: icefox child 965 MB -> 2.19 GB RSS,
// 116% CPU, 6 h; one pathToBlock search alone: 50 min at 75% CPU, 30 MB/min):
// mineflayer-pathfinder's default bestHarvestTool (index.js:46-58) runs
// nbt.simplify(tool.nbt) and block.digTime for EVERY inventory item on EVERY
// candidate move of EVERY node the A* expands (lib/movements.js safeOrBreak ->
// canDigThenMove -> bestHarvestTool). The reachability search deliberately runs
// until the open set is exhausted (src/agent/library/world.js pathToBlock,
// fix97 "only noPath means unreachable"; the loaded columns bound the open set:
// prismarine-world src/worldsync.js:98 getBlock returns null outside them and
// mineflayer src/lib/plugins/blocks.js:251 blockAt returns null, which
// mineflayer-pathfinder lib/movements.js:231-242 treats as impassable). The
// search volume is doctrine; a per-node NBT decode is not. Measured with
// --cpu-prof on the live child: nbt transform/simplify 38%, bestHarvestTool
// 10%, digTime+getEffectLevel 8% — half of all CPU and the dominant allocator.
//
// The default's answer depends only on:
//   - block.name — digTime reads this.material/this.hardness/this.canHarvest,
//     all registry data keyed by block name (prismarine-block index.js:306-360);
//   - the inventory items (their type and nbt enchantments) and
//     bot.entity.effects, passed through unchanged;
//   - nothing else: the default passes inWater=false, notOnGround=false,
//     creative=false as constants.
// So the choice can be cached per block name and recomputed only when the
// inventory items or the effects change. This wraps the plugin's own default —
// same function, same answers, computed once per (block name, inputs) instead
// of once per A* node. Item identity is a sound change signal: mineflayer
// rebuilds Item instances from packets when a slot changes (blocks.js
// setSlot -> createItem), and nbt only changes with a fresh instance.
//
// Documented extension point: mineflayer-pathfinder readme.md
// "bot.pathfinder.bestHarvestTool(block) — Returns the best harvesting tool in
// the inventory for the specified block" (assignable).

let nextId = 0;
const idOf = (() => {
    const ids = new WeakMap();
    return (obj) => {
        if (ids.has(obj)) return ids.get(obj);
        const id = ++nextId;
        ids.set(obj, id);
        return id;
    };
})();

function effectsKey(effects) {
    // bot.entity.effects: { effectName: { id, amplifier, ... } } (prismarine-entity).
    // Key on name+amplifier — the values digTime reads (prismarine-block
    // index.js:327-343 getEffectLevel).
    if (!effects) return '';
    let key = '';
    for (const name of Object.keys(effects).sort()) {
        const e = effects[name];
        key += `${name}:${e && e.amplifier !== undefined ? e.amplifier : e},`;
    }
    return key;
}

export function installCachedBestHarvestTool(bot) {
    if (!bot || !bot.pathfinder || typeof bot.pathfinder.bestHarvestTool !== 'function') {
        throw new Error('fix114: bot.pathfinder.bestHarvestTool is missing. The cache wraps the mineflayer-pathfinder default (index.js:46).');
    }
    if (bot.pathfinder.__mcCachedBestHarvestTool) return; // idempotent across re-attach
    const defaultBestHarvestTool = bot.pathfinder.bestHarvestTool;

    let inputsKey = null;
    let byBlockName = new Map();

    bot.pathfinder.bestHarvestTool = (block) => {
        if (!block) return defaultBestHarvestTool(block);
        // Input fingerprint: every inventory item's identity + type, plus effects.
        // Item ids are WeakMap-assigned per instance (no leak, no parse), so the
        // fingerprint changes exactly when an instance is replaced — the only way
        // the default's inputs (type, nbt) can change.
        let key = effectsKey(bot.entity && bot.entity.effects);
        for (const item of bot.inventory.items()) {
            key += `${idOf(item)}:${item.type},`;
        }
        if (key !== inputsKey) {
            inputsKey = key;
            byBlockName = new Map();
        }
        const cached = byBlockName.get(block.name);
        if (cached !== undefined) return cached;
        const chosen = defaultBestHarvestTool(block);
        byBlockName.set(block.name, chosen);
        return chosen;
    };
    bot.pathfinder.__mcCachedBestHarvestTool = true;
}

// Test hook: rebuild the wrapper over an arbitrary default (for differential tests).
export function _wrapBestHarvestToolForTest(bot, defaultImpl) {
    bot.pathfinder.bestHarvestTool = defaultImpl;
    bot.pathfinder.__mcCachedBestHarvestTool = false;
    installCachedBestHarvestTool(bot);
}
