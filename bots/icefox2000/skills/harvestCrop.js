// Harvest up to count fully grown crops (wheat, carrots, potatoes, beetroots) within 32 blocks and pick up drops; returns how many were harvested.
// DESCRIPTION: Harvest up to count fully grown crops (wheat, carrots, potatoes, beetroots) within 32 blocks and pick up drops; returns how many were harvested.
async function harvestCrop(bot, crop = 'wheat', count = 4) {
    const maxAge = crop === 'beetroots' ? 3 : 7;
    let n = 0;
    for (let i = 0; i < count; i++) {
        if (bot.interrupt_code) return n;
        const b = world.getNearestBlocksWhere(bot, bl => bl.name === crop && bl.getProperties?.().age === maxAge, 32, 1)[0];
        if (!b) break;
        await skills.breakBlockAt(bot, b.position.x, b.position.y, b.position.z);
        n++;
    }
    await skills.pickupNearbyItems(bot);
    return n;
}
