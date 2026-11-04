// Cook up to count raw meat/fish from the inventory in a furnace; returns true if anything was cooked.
// DESCRIPTION: Cook up to count raw meat/fish from the inventory in a furnace; returns true if anything was cooked.
async function cookFood(bot, count = 1) {
    const raw = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato'];
    const inv = world.getInventoryCounts(bot);
    const item = raw.find(r => inv[r]);
    if (!item) return false;
    return await smeltWithFuel(bot, item, Math.min(count, inv[item]));
}
