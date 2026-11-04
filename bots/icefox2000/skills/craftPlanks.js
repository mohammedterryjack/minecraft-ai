// Craft planks from whatever logs are in the inventory until there are at least target planks; returns true on success.
// DESCRIPTION: Craft planks from whatever logs are in the inventory until there are at least target planks; returns true on success.
async function craftPlanks(bot, target = 4) {
    const planks = () => Object.entries(world.getInventoryCounts(bot)).filter(([k]) => k.endsWith('_planks')).reduce((a, [, v]) => a + v, 0);
    for (let i = 0; i < 16 && planks() < target; i++) {
        if (bot.interrupt_code) return false;
        const log = Object.keys(world.getInventoryCounts(bot)).find(k => k.endsWith('_log') && !k.startsWith('stripped'));
        if (!log) return false;
        if (!(await skills.craftRecipe(bot, log.replace('_log', '_planks'), 1))) return false;
    }
    return planks() >= target;
}
