// Fight hostile mobs within range (max 48) until none are left or 10 fights; returns how many were killed.
// DESCRIPTION: Fight hostile mobs within range (max 48) until none are left or 10 fights; returns how many were killed.
async function killMonsters(bot, range = 16) {
    range = Math.min(range, 48);
    const hostile = ['zombie', 'skeleton', 'spider', 'creeper', 'husk', 'drowned', 'witch', 'slime', 'cave_spider', 'enderman', 'pillager', 'zombie_villager', 'stray'];
    let n = 0;
    for (let i = 0; i < 10; i++) {
        if (bot.interrupt_code) return n;
        const e = bot.nearestEntity(en => hostile.includes(en.name) && en.position.distanceTo(bot.entity.position) <= range);
        if (!e) break;
        if (!(await equipBestTool(bot, 'sword'))) await equipBestTool(bot, 'axe');
        if (await skills.attackEntity(bot, e, true)) n++;
    }
    return n;
}
