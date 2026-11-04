// Store the given item names (or all non-essential items) in the nearest chest within 32 blocks (placing one if needed); if storage fails, toss low-value clutter to free at least 6 slots; returns how many stacks were stored.
// DESCRIPTION: Store the given item names (or all non-essential items) in the nearest chest within 32 blocks (placing one if needed); if storage fails, toss low-value clutter to free at least 6 slots; returns how many stacks were stored.
async function depositToChest(bot, itemNames = []) {
    const keep = /pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots|torch|cooked_|bread|crafting_table|shield/;
    const names = itemNames.length ? itemNames : [...new Set(bot.inventory.items().map(i => i.name))].filter(n => !keep.test(n));
    let n = 0;
    if (await ensureChest(bot) && !bot.interrupt_code) {
        await skills.goToNearestBlock(bot, 'chest', 2, 32);
        for (const name of names.slice(0, 27)) {
            if (bot.interrupt_code) return n;
            if (await skills.putInChest(bot, name)) n++;
        }
    }
    if (bot.inventory.emptySlotCount() < 6 && !bot.interrupt_code) {
        console.log(`[toss] storage left only ${bot.inventory.emptySlotCount()} empty slots (stored ${n} stacks); tossing clutter`);
        await tossClutter(bot, 6);
    }
    return n;
}
