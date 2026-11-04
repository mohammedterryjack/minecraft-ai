// Eat the best food in the inventory when hungry
// DESCRIPTION: Eat the most filling food item in the inventory if food is below 20; returns true if something was eaten.
async function eatFood(bot) {
    if (bot.food >= 20) return true;
    const order = ['golden_carrot','cooked_beef','cooked_porkchop','cooked_mutton','cooked_salmon','cooked_chicken','cooked_cod','bread','baked_potato','cooked_rabbit','apple','carrot','beef','porkchop','mutton','chicken','potato','sweet_berries','melon_slice'];
    const inv = world.getInventoryCounts(bot);
    const food = order.find(f => inv[f]);
    if (!food) return false;
    return await skills.consume(bot, food);
}
