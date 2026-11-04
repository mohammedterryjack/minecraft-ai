// Craft a pickaxe, axe and sword of one material (wooden, stone, iron)
// DESCRIPTION: Craft a pickaxe, axe and sword of the given material (wooden, stone, iron), plus sticks if short; returns true if all three exist.
async function craftToolSet(bot, material = 'stone') {
    const tools = ['pickaxe', 'axe', 'sword'].map(t => material + '_' + t);
    if ((world.getInventoryCounts(bot)['stick'] || 0) < 5) await craftItem(bot, 'stick', 5);
    for (const t of tools) {
        if (bot.interrupt_code) return false;
        if (!world.getInventoryCounts(bot)[t]) await craftItem(bot, t, 1);
    }
    const inv = world.getInventoryCounts(bot);
    return tools.every(t => inv[t]);
}
