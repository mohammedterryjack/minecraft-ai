// Craft sticks (making planks from logs if needed) until the inventory has target sticks; returns true on success.
// DESCRIPTION: Craft sticks (making planks from logs if needed) until the inventory has target sticks; returns true on success.
async function craftSticks(bot, target = 4) {
    const have = () => world.getInventoryCounts(bot).stick || 0;
    for (let i = 0; i < 8 && have() < target; i++) {
        if (bot.interrupt_code) return false;
        await craftPlanks(bot, 2);
        if (!(await skills.craftRecipe(bot, 'stick', 1))) return false;
    }
    return have() >= target;
}
