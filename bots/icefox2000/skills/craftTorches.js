// Craft torches until the inventory has target, making sticks and mining coal if needed; returns true on success.
// DESCRIPTION: Craft torches until the inventory has target, making sticks and mining coal if needed; returns true on success.
async function craftTorches(bot, target = 4) {
    const have = () => world.getInventoryCounts(bot).torch || 0;
    for (let i = 0; i < 6 && have() < target; i++) {
        if (bot.interrupt_code) return false;
        const inv = world.getInventoryCounts(bot);
        if (!inv.coal && !inv.charcoal) { await mineOre(bot, 'coal_ore', 1); if (bot.interrupt_code) return false; }
        if (!(world.getInventoryCounts(bot).stick)) await craftSticks(bot, 1);
        if (!(await skills.craftRecipe(bot, 'torch', 1))) return false;
    }
    return have() >= target;
}
