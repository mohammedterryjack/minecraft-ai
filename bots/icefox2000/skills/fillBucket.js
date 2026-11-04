// Fill a bucket with water, lava or milk (from a cow) within 16 blocks, crafting a bucket from 3 iron_ingot if needed; returns true on success.
// DESCRIPTION: Fill a bucket with water, lava or milk (from a cow) within 16 blocks, crafting a bucket from 3 iron_ingot if needed; returns true on success.
async function fillBucket(bot, what = 'water') {
    const out = what === 'milk' ? 'milk_bucket' : `${what}_bucket`;
    const before = world.getInventoryCounts(bot)[out] || 0;
    if (!world.getInventoryCounts(bot).bucket && !(await craftItem(bot, 'bucket', 1))) return false;
    if (bot.interrupt_code) return false;
    await skills.equip(bot, 'bucket');
    if (what === 'milk') {
        const cow = bot.nearestEntity(e => e.name === 'cow' && e.position.distanceTo(bot.entity.position) <= 16);
        if (!cow) return false;
        await skills.goToPosition(bot, cow.position.x, cow.position.y, cow.position.z, 2);
        await skills.equip(bot, 'bucket');
        await bot.useOn(cow);
    } else {
        const src = world.getNearestBlocksWhere(bot, b => b.name === what && b.metadata === 0, 16, 1)[0];
        if (!src) return false;
        await skills.goToPosition(bot, src.position.x, src.position.y, src.position.z, 3);
        await skills.equip(bot, 'bucket');
        await bot.lookAt(src.position.offset(0.5, 0.5, 0.5));
        bot.activateItem();
    }
    await skills.wait(bot, 800);
    return (world.getInventoryCounts(bot)[out] || 0) > before;
}
