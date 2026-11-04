// Obtain count of itemName by the right route: logs -> collectLogs, ores/stone -> mineOre, surface blocks -> collectSurface, smelted items -> smeltWithFuel, else craftItem; returns true if the inventory has count.
// DESCRIPTION: Obtain count of itemName by the right route: logs -> collectLogs, ores/stone -> mineOre, surface blocks -> collectSurface, smelted items -> smeltWithFuel, else craftItem; returns true if the inventory has count.
async function obtainItem(bot, itemName, count = 1) {
    const have = () => world.getInventoryCounts(bot)[itemName] || 0;
    if (have() >= count) return true;
    const need = count - have();
    const smelt = { iron_ingot: 'raw_iron', copper_ingot: 'raw_copper', gold_ingot: 'raw_gold', glass: 'sand', stone: 'cobblestone', charcoal: 'oak_log', smooth_stone: 'stone' };
    const drops = { cobblestone: 'stone', raw_iron: 'iron_ore', raw_copper: 'copper_ore', raw_gold: 'gold_ore', coal: 'coal_ore', diamond: 'diamond_ore', redstone: 'redstone_ore', lapis_lazuli: 'lapis_ore', emerald: 'emerald_ore', flint: 'gravel' };
    if (itemName.endsWith('_log')) await collectLogs(bot, need, itemName);
    else if (itemName.endsWith('_planks')) await craftPlanks(bot, count);
    else if (itemName === 'stick') await craftSticks(bot, count);
    else if (itemName === 'torch') await craftTorches(bot, count);
    else if (drops[itemName] === 'gravel') await collectSurface(bot, 'gravel', need * 3);
    else if (drops[itemName]) await mineOre(bot, drops[itemName], need);
    else if (/_ore$/.test(itemName)) await mineOre(bot, itemName, need);
    else if (smelt[itemName] && itemName !== 'stone') {
        if ((world.getInventoryCounts(bot)[smelt[itemName]] || 0) < need && !bot.interrupt_code) await obtainItem(bot, smelt[itemName], need);
        if (!bot.interrupt_code) await smeltWithFuel(bot, smelt[itemName], need);
    }
    else if (/^(dirt|sand|gravel|clay_ball|sugar_cane|cactus|bamboo|pumpkin|melon)/.test(itemName)) await collectSurface(bot, itemName === 'clay_ball' ? 'clay' : itemName, need);
    else { await ensureCraftingTable(bot); if (!bot.interrupt_code) await craftItem(bot, itemName, count); }
    return have() >= count;
}
