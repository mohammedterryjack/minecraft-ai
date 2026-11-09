// fix95: the blocks that yield an item when broken, from the game's own data (registry.blockLoot, no silk touch), plus
// the block of that name. A search for an item is a search for these blocks. An item no block yields (an apple is in
// oak_leaves' loot, wheat_seeds in tall_grass' loot, a cooked food in none) has no block source: searching the world for
// its name found nothing, returned null with no I/O, and generated code that retried it spun the event loop until the
// watchdog killed the process (live 13:47 GMT 9 Nov: 3,500 "search miss for wheat_seeds" lines, then SIGKILL).
// A loot table entry whose block name is not a block in this registry (1.20.4 data keeps the pre-1.20.3 name "grass")
// is not a block the bot can find, so it is not a source.
export function itemSourceBlocks(registry, item) {
    if (!registry || typeof registry !== 'object') throw new Error('[fix95] itemSourceBlocks: registry required');
    if (!registry.blockLoot || typeof registry.blockLoot !== 'object') throw new Error('[fix95] itemSourceBlocks: registry.blockLoot required');
    if (!registry.blocksByName || typeof registry.blocksByName !== 'object') throw new Error('[fix95] itemSourceBlocks: registry.blocksByName required');
    if (typeof item !== 'string' || item.length === 0) throw new Error(`[fix95] itemSourceBlocks: item name required, got ${JSON.stringify(item)}`);
    const out = [];
    if (Object.hasOwn(registry.blocksByName, item)) out.push(item);
    for (const [block, loot] of Object.entries(registry.blockLoot)) {
        if (!Object.hasOwn(registry.blocksByName, block)) continue;
        if (out.includes(block)) continue;
        if (!loot || !Array.isArray(loot.drops)) throw new Error(`[fix95] blockLoot[${JSON.stringify(block)}].drops must be an array`);
        if (loot.drops.some(d => d.item === item && !d.silkTouch)) out.push(block);
    }
    return out;
}
