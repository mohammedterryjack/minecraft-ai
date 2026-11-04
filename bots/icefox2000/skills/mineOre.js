// Mine count of an ore or stone (coal_ore, iron_ore, diamond_ore, stone, deepslate variants...), first equipping or crafting a pickaxe good enough for it; returns items gained.
// DESCRIPTION: Mine count of an ore or stone (coal_ore, iron_ore, diamond_ore, stone, deepslate variants...), first equipping or crafting a pickaxe good enough for it; returns items gained.
async function mineOre(bot, oreName, count = 1) {
    const need = { stone: 'wooden', cobblestone: 'wooden', coal_ore: 'wooden', copper_ore: 'stone', iron_ore: 'stone', lapis_ore: 'stone', gold_ore: 'iron', redstone_ore: 'iron', diamond_ore: 'iron', emerald_ore: 'iron' };
    const rank = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 };
    const base = oreName.replace('deepslate_', '');
    const req = need[base] || 'wooden';
    let held = await equipToolOrCraft(bot, 'pickaxe');
    if (bot.interrupt_code) return 0;
    const tier = held ? held.split('_')[0] : null;
    if (!tier || rank[tier] < rank[req]) { log(bot, `mineOre: need a ${req}_pickaxe or better for ${oreName}`); return 0; }
    return await mineBlocks(bot, oreName === 'cobblestone' ? 'stone' : oreName, count);
}
