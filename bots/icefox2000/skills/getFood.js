// Get at least n cooked food: hunt cows/pigs/sheep/chickens within 48 blocks, cook the meat, then eat if hungry; returns true if the inventory has n cooked food.
// DESCRIPTION: Get at least n cooked food: hunt cows/pigs/sheep/chickens within 48 blocks, cook the meat, then eat if hungry; returns true if the inventory has n cooked food.
async function getFood(bot, n = 2) {
    const cooked = () => Object.entries(world.getInventoryCounts(bot)).filter(([k]) => k.startsWith('cooked_') || k === 'bread' || k === 'baked_potato').reduce((a, [, v]) => a + v, 0);
    for (const mob of ['cow', 'pig', 'sheep', 'chicken']) {
        if (bot.interrupt_code || cooked() >= n) break;
        await killMob(bot, mob, n - cooked());
    }
    if (bot.interrupt_code) return false;
    if (cooked() < n) await cookFood(bot, n);
    if (bot.food < 14) await eatFood(bot);
    return cooked() >= n;
}
