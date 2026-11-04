// Equip the best tool of toolType (pickaxe, axe, sword, shovel, hoe) in the inventory; returns the item name or null.
// DESCRIPTION: Equip the best tool of toolType (pickaxe, axe, sword, shovel, hoe) in the inventory; returns the item name or null.
async function equipBestTool(bot, toolType = 'pickaxe') {
    const tiers = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
    const inv = world.getInventoryCounts(bot);
    for (const t of tiers) {
        const name = `${t}_${toolType}`;
        if (inv[name]) { await skills.equip(bot, name); return name; }
    }
    return null;
}
