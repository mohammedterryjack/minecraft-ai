// Smelt count of inputName (raw_iron, raw_copper, raw_gold, sand, cactus, cobblestone...), placing a furnace and finding fuel if needed; returns true on success.
// DESCRIPTION: Smelt count of inputName (raw_iron, raw_copper, raw_gold, sand, cactus, cobblestone...), placing a furnace and finding fuel if needed; returns true on success.
async function smeltWithFuel(bot, inputName, count = 1) {
    if ((world.getInventoryCounts(bot)[inputName] || 0) < count) { log(bot, `smeltWithFuel: only have ${world.getInventoryCounts(bot)[inputName] || 0} ${inputName}`); return false; }
    if (!world.getNearestBlock(bot, 'furnace', 48) && !(await ensureFurnace(bot))) return false;
    if (bot.interrupt_code) return false;
    const inv = world.getInventoryCounts(bot);
    const hasFuel = inv.coal || inv.charcoal || Object.keys(inv).some(k => k.endsWith('_planks') || k.endsWith('_log'));
    if (!hasFuel) { await mineOre(bot, 'coal_ore', 2); if (bot.interrupt_code) return false; }
    return await smeltItems(bot, inputName, count);
}
