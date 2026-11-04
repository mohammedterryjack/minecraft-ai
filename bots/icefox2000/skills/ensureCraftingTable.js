// Make sure a crafting_table is within 16 blocks, crafting and placing one if not; returns true if one is available.
// DESCRIPTION: Make sure a crafting_table is within 16 blocks, crafting and placing one if not; returns true if one is available.
async function ensureCraftingTable(bot) {
    if (world.getNearestBlock(bot, 'crafting_table', 16)) return true;
    if (!world.getInventoryCounts(bot).crafting_table) {
        if (!(await craftPlanks(bot, 4)) || bot.interrupt_code) return false;
        if (!(await skills.craftRecipe(bot, 'crafting_table', 1))) return false;
    }
    if (bot.interrupt_code) return false;
    const pos = world.getNearestFreeSpace(bot, 1, 6);
    if (!pos) return false;
    await skills.placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
    return !!world.getNearestBlock(bot, 'crafting_table', 16);
}
