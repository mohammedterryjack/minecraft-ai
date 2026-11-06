// fix70: what the bot carries, defined once. getInventoryCounts (what the learner and every skill see as "have N") and the
// seeded primitives that look an item up by name (consume, equip) read these same slots, so "have 50" and "you do not have
// any" can no longer both be true. Before, consume/equip searched only the main+hotbar range (findInventoryItem; mindcraft
// 6b0006a, and items() before it) while getInventoryCounts counted from the first armour slot to the off-hand (b2e2338):
// food in the off-hand was counted but could not be eaten.
//
// PLAYER_WINDOW is the Java Edition protocol slot layout of the player inventory window (window id 0; minecraft.wiki
// "Java Edition protocol/Inventory", Player Inventory):
//   0 crafting output | 1-4 crafting input (2x2) | 5-8 armour head, chest, legs, feet | 9-35 main | 36-44 hotbar | 45 off-hand
// Nothing at runtime describes the whole layout: prismarine-windows' Window gives inventoryStart (9), inventoryEnd (45,
// exclusive) and hotbarStart (36) only, and mineflayer keeps the armour/off-hand slots as private literals
// (simple_inventory.js armorSlots). test/fix70-eating.test.js checks this constant against both, so a protocol or library
// change that moves a slot fails the suite instead of silently miscounting.
export const PLAYER_WINDOW = Object.freeze({
    craftingOutput: 0,
    craftingInput: Object.freeze([1, 2, 3, 4]),
    armour: Object.freeze({ head: 5, torso: 6, legs: 7, feet: 8 }),
    mainStart: 9,
    hotbarStart: 36,
    offHand: 45,
    size: 46,
});
// carried = everything after the crafting grid: armour, main, hotbar, off-hand
const FIRST_CARRIED = PLAYER_WINDOW.craftingInput[PLAYER_WINDOW.craftingInput.length - 1] + 1;
export function carriedSlots(bot) { return bot.inventory.slots.slice(FIRST_CARRIED, PLAYER_WINDOW.size); }
export function findCarried(bot, name) {
    if (typeof name !== 'string' || !name) throw new Error(`findCarried: item name must be a non-empty string, got ${JSON.stringify(name)}`);
    return carriedSlots(bot).find(s => s && s.name === name);
}
