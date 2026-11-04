// Shear up to count sheep within 16 blocks (crafting shears from 2 iron_ingot if needed); returns how many were sheared.
// DESCRIPTION: Shear up to count sheep within 16 blocks (crafting shears from 2 iron_ingot if needed); returns how many were sheared.
async function shearSheep(bot, count = 1) {
    if (!world.getInventoryCounts(bot).shears && !(await craftItem(bot, 'shears', 1))) return 0;
    let n = 0;
    for (let i = 0; i < count; i++) {
        if (bot.interrupt_code) return n;
        const s = bot.nearestEntity(e => e.name === 'sheep' && e.position.distanceTo(bot.entity.position) <= 16 && !(e.metadata?.[17] & 0x10));
        if (!s) break;
        await skills.goToPosition(bot, s.position.x, s.position.y, s.position.z, 2);
        await skills.equip(bot, 'shears');
        await bot.useOn(s);
        n++;
        await skills.wait(bot, 500);
    }
    await skills.pickupNearbyItems(bot);
    return n;
}
