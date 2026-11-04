// Till and plant up to count seeds (wheat_seeds, carrot, potato, beetroot_seeds, melon_seeds, pumpkin_seeds) on dirt/grass near water within 16 blocks; returns how many were planted.
// DESCRIPTION: Till and plant up to count seeds (wheat_seeds, carrot, potato, beetroot_seeds, melon_seeds, pumpkin_seeds) on dirt/grass near water within 16 blocks; returns how many were planted.
async function plantSeeds(bot, seed = 'wheat_seeds', count = 4) {
    if (!(await equipToolOrCraft(bot, 'hoe'))) return 0;
    let n = 0;
    for (let i = 0; i < count * 2 && n < count; i++) {
        if (bot.interrupt_code || !(world.getInventoryCounts(bot)[seed])) break;
        const soil = world.getNearestBlocksWhere(bot, bl => {
            if (!['dirt', 'grass_block', 'farmland'].includes(bl.name)) return false;
            const above = bot.blockAt(bl.position.offset(0, 1, 0));
            return above && above.name === 'air';
        }, 16, 1)[0];
        if (!soil) break;
        if (await skills.tillAndSow(bot, soil.position.x, soil.position.y, soil.position.z, seed)) n++;
        else break;
    }
    return n;
}
