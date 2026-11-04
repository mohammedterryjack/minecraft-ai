// Equip the best toolType, crafting one (iron > stone > wooden) if none is held; returns the equipped name or null.
// DESCRIPTION: Equip the best toolType, crafting one (iron > stone > wooden) if none is held; returns the equipped name or null.
async function equipToolOrCraft(bot, toolType = 'pickaxe') {
    let got = await equipBestTool(bot, toolType);
    if (got) return got;
    const inv = world.getInventoryCounts(bot);
    const planks = Object.keys(inv).filter(k => k.endsWith('_planks')).reduce((a, k) => a + inv[k], 0);
    const mat = (inv.iron_ingot || 0) >= 3 ? 'iron' : (inv.cobblestone || 0) >= 3 ? 'stone' : planks >= 3 || Object.keys(inv).some(k => k.endsWith('_log')) ? 'wooden' : null;
    if (!mat || bot.interrupt_code) return null;
    if ((inv.stick || 0) < 2) await craftSticks(bot, 4);
    if (bot.interrupt_code) return null;
    await craftItem(bot, `${mat}_${toolType}`, 1);
    return await equipBestTool(bot, toolType);
}
