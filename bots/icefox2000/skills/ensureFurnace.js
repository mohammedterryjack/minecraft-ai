// Make sure a furnace is within 16 blocks, mining cobblestone, crafting and placing one if not; returns true if one is available.
// DESCRIPTION: Make sure a furnace is within 16 blocks, mining cobblestone, crafting and placing one if not; returns true if one is available.
async function ensureFurnace(bot) {
    if (world.getNearestBlock(bot, 'furnace', 16)) return true;
    if (!world.getInventoryCounts(bot).furnace) {
        if ((world.getInventoryCounts(bot).cobblestone || 0) < 8) await mineOre(bot, 'stone', 8 - (world.getInventoryCounts(bot).cobblestone || 0));
        if (bot.interrupt_code || (world.getInventoryCounts(bot).cobblestone || 0) < 8) return false;
        if (!(await ensureCraftingTable(bot)) || bot.interrupt_code) return false;
        if (!(await craftItem(bot, 'furnace', 1))) return false;
    }
    if (bot.interrupt_code) return false;
    const pos = world.getNearestFreeSpace(bot, 1, 6);
    if (!pos) return false;
    await skills.placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
    return !!world.getNearestBlock(bot, 'furnace', 16);
}
