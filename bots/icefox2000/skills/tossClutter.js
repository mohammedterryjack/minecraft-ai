// Toss low-value clutter (pink_petals, flowers, seeds, excess sweet_berries/dirt/gravel/snowballs/kelp) until at least minFree inventory slots are empty; never tosses tools, armour, ores, ingots, wood or food essentials; returns empty slots.
// DESCRIPTION: Toss low-value clutter (pink_petals, flowers, seeds, excess sweet_berries/dirt/gravel/snowballs/kelp) until at least minFree inventory slots are empty; never tosses tools, armour, ores, ingots, wood or food essentials; returns empty slots.
async function tossClutter(bot, minFree = 6) {
    const always = /^(pink_petals|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|[a-z]+_tulip|sunflower|lilac|rose_bush|peony|short_grass|grass|fern|dead_bush|[a-z]+_seeds|spider_eye|rotten_flesh|poisonous_potato|bamboo_mosaic|phantom_membrane)$/;
    const excess = { sweet_berries: 16, dirt: 16, gravel: 8, snowball: 4, kelp: 4, egg: 0, cherry_door: 0, acacia_boat: 0, prismarine_shard: 0, prismarine_crystals: 0 };
    for (let i = 0; i < 40 && bot.inventory.emptySlotCount() < minFree; i++) {
        if (bot.interrupt_code) break;
        const counts = world.getInventoryCounts(bot);
        let pick = Object.keys(counts).find(n => always.test(n) && counts[n] > 0);
        let n = pick ? counts[pick] : 0;
        if (!pick) { pick = Object.keys(excess).find(k => (counts[k] || 0) > excess[k]); n = pick ? counts[pick] - excess[pick] : 0; }
        if (!pick) break;
        const it = bot.inventory.items().find(x => x.name === pick);
        if (bot.currentWindow) { console.log(`[toss] closing open ${bot.currentWindow.type} window first`); bot.closeWindow(bot.currentWindow); await skills.wait(bot, 500); }
        if (n >= it.count) await bot.tossStack(it); else await bot.toss(it.type, null, n);
        console.log(`[toss] tossed ${Math.min(n, it.count)} ${pick} (empty slots now ${bot.inventory.emptySlotCount()})`);
    }
    if (bot.inventory.emptySlotCount() < minFree) console.log(`[toss] FAILED to free ${minFree} slots; only ${bot.inventory.emptySlotCount()} empty (nothing tossable left)`);
    return bot.inventory.emptySlotCount();
}
