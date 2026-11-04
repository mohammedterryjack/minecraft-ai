// Craft a bed from 3 wool of one colour and 3 planks (shearing sheep for wool if needed), then return true if a bed is in the inventory.
// DESCRIPTION: Craft a bed from 3 wool of one colour and 3 planks (shearing sheep for wool if needed), then return true if a bed is in the inventory.
async function craftBed(bot) {
    const wool = () => Object.entries(world.getInventoryCounts(bot)).filter(([k]) => k.endsWith('_wool')).sort((a, b) => b[1] - a[1])[0];
    for (let i = 0; i < 3 && (!wool() || wool()[1] < 3); i++) {
        if (bot.interrupt_code) return false;
        if (!(await shearSheep(bot, 2))) break;
    }
    const w = wool();
    if (!w || w[1] < 3 || bot.interrupt_code) return false;
    await craftPlanks(bot, 3);
    if (!(await ensureCraftingTable(bot))) return false;
    return await craftItem(bot, w[0].replace('_wool', '_bed'), 1);
}
