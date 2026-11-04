// Craft an item until the inventory has N, walking to a nearby crafting table if needed
// DESCRIPTION: Craft itemName until the inventory holds at least target, walking to the nearest crafting_table if one is needed; returns true on success.
async function craftItem(bot, itemName, target = 1) {
    const have = () => world.getInventoryCounts(bot)[itemName] || 0;
    if (!world.getNearestBlock(bot, 'crafting_table', 6) && !world.getInventoryCounts(bot)['crafting_table'])
        await skills.goToNearestBlock(bot, 'crafting_table', 3, 48);
    for (let i = 0; i < target && have() < target; i++) {
        if (bot.interrupt_code) return false;
        if (!(await skills.craftRecipe(bot, itemName, 1))) break;
    }
    return have() >= target;
}
