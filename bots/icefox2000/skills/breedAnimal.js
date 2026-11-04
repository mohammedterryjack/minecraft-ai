// Feed two nearby animals of a type (cow/sheep: wheat, pig: carrot, chicken: wheat_seeds) within 16 blocks so they breed; returns true if two were fed.
// DESCRIPTION: Feed two nearby animals of a type (cow/sheep: wheat, pig: carrot, chicken: wheat_seeds) within 16 blocks so they breed; returns true if two were fed.
async function breedAnimal(bot, animal = 'cow') {
    const food = { cow: 'wheat', sheep: 'wheat', pig: 'carrot', chicken: 'wheat_seeds', rabbit: 'carrot' }[animal];
    if (!food || (world.getInventoryCounts(bot)[food] || 0) < 2) return false;
    const mobs = Object.values(bot.entities).filter(e => e.name === animal && e.position.distanceTo(bot.entity.position) <= 16).slice(0, 2);
    if (mobs.length < 2) return false;
    for (const m of mobs) {
        if (bot.interrupt_code) return false;
        await skills.goToPosition(bot, m.position.x, m.position.y, m.position.z, 2);
        await skills.equip(bot, food);
        await bot.useOn(m);
        await skills.wait(bot, 500);
    }
    return true;
}
