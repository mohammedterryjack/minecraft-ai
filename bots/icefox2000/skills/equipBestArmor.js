// Wear the best helmet, chestplate, leggings and boots in the inventory; returns how many pieces were equipped.
// DESCRIPTION: Wear the best helmet, chestplate, leggings and boots in the inventory; returns how many pieces were equipped.
async function equipBestArmor(bot) {
    const tiers = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather'];
    const inv = world.getInventoryCounts(bot);
    let n = 0;
    for (const slot of ['helmet', 'chestplate', 'leggings', 'boots']) {
        if (bot.interrupt_code) return n;
        const t = tiers.find(t => inv[`${t}_${slot}`]);
        if (t && await skills.equip(bot, `${t}_${slot}`)) n++;
    }
    return n;
}
