// fix70: what the bot carries, defined once. Every slot of the player inventory window except the 2x2 crafting result and
// grid (0-4): armour 5-8, main 9-35, hotbar 36-44, off-hand 45. getInventoryCounts (what the learner and every skill see as
// "have N") and the seeded primitives that look an item up by name (consume, equip) read these same slots, so "have 50"
// and "you do not have any" can no longer both be true. Before, consume/equip searched only 9-44 (findInventoryItem;
// mindcraft 6b0006a, and items() before it) while getInventoryCounts counted 5-45 (b2e2338): food in the off-hand was
// counted but could not be eaten.
export function carriedSlots(bot) { return bot.inventory.slots.slice(5); }
export function findCarried(bot, name) {
    if (typeof name !== 'string' || !name) throw new Error(`findCarried: item name must be a non-empty string, got ${JSON.stringify(name)}`);
    return carriedSlots(bot).find(s => s && s.name === name);
}
