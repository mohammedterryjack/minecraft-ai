// Free inventory space: if fewer than 3 slots are empty, first toss low-value clutter on the spot (no walking); then store the given item names (or all non-essential items) in the nearest chest within 32 blocks (placing one if needed), tossing clutter again if still under 6 empty slots; returns how many stacks were stored.
// DESCRIPTION: Free inventory space: if fewer than 3 slots are empty, first toss low-value clutter on the spot (no walking); then store the given item names (or all non-essential items) in the nearest chest within 32 blocks (placing one if needed), tossing clutter again if still under 6 empty slots; returns how many stacks were stored.
async function depositToChest(bot, itemNames = []) {
    if (bot.inventory.emptySlotCount() < 3) {
        console.log(`[toss] only ${bot.inventory.emptySlotCount()} empty slots; tossing clutter first (no walking)`);
        await tossClutter(bot, 6);
        if (bot.interrupt_code) return 0;
    }
    const keep = /pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots|torch|cooked_|bread|crafting_table|shield/;
    const names = itemNames.length ? itemNames : [...new Set(bot.inventory.items().map(i => i.name))].filter(n => !keep.test(n));
    let n = 0;
    if (await ensureChest(bot) && !bot.interrupt_code) {
        await skills.goToNearestBlock(bot, 'chest', 2, 32);
        for (const name of names.slice(0, 27)) {
            if (bot.interrupt_code) return n;
            if (await skills.putInChest(bot, name)) n++;
        }
        console.log(`[chest] stored ${n} stacks; empty slots now ${bot.inventory.emptySlotCount()}`);
    }
    if (bot.inventory.emptySlotCount() < 6 && !bot.interrupt_code) {
        console.log(`[toss] storage left only ${bot.inventory.emptySlotCount()} empty slots (stored ${n} stacks); tossing clutter`);
        await tossClutter(bot, 6);
    }
    return n;
}
