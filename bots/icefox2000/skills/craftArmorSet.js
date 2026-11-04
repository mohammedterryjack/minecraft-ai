// Craft and wear any missing helmet, chestplate, leggings and boots of material (iron, diamond, golden, leather); returns pieces worn.
// DESCRIPTION: Craft and wear any missing helmet, chestplate, leggings and boots of material (iron, diamond, golden, leather); returns pieces worn.
async function craftArmorSet(bot, material = 'iron') {
    if (!(await ensureCraftingTable(bot))) return 0;
    for (const slot of ['helmet', 'chestplate', 'leggings', 'boots']) {
        if (bot.interrupt_code) return 0;
        if (!world.getInventoryCounts(bot)[`${material}_${slot}`]) await craftItem(bot, `${material}_${slot}`, 1);
    }
    return await equipBestArmor(bot);
}
