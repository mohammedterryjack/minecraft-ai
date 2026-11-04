// Fight hostile mobs within range (max 48) until none are left or 10 fights; returns how many were killed.
// DESCRIPTION: Fight hostile mobs within range (max 48) until none are left or 10 fights; returns how many were killed.
async function killMonsters(bot, range = 16) {
    range = Math.min(range, 48);
    const hostile = ['zombie', 'skeleton', 'spider', 'creeper', 'husk', 'drowned', 'witch', 'slime', 'cave_spider', 'enderman', 'pillager', 'zombie_villager', 'stray'];
    // fix5: 'A Breach Happened' figures (mannequins, profile "fd", 60 HP) are hostile but too strong; flee instead of fighting
    const isFigure = en => en !== bot.entity && (en.name === 'mannequin' || (en.type === 'player' && (en.username === 'fd' || !en.username)) || /Black Figure|Red Figure|The Man\b/i.test(JSON.stringify(en.metadata ?? '') + (en.customName ?? '')));
    const fig = bot.nearestEntity(en => isFigure(en) && en.position.distanceTo(bot.entity.position) <= Math.max(range, 24));
    if (fig) { console.log(`[killMonsters] datapack hostile ${fig.name} ${fig.position.distanceTo(bot.entity.position).toFixed(1)} blocks away; fleeing instead of fighting`); await skills.avoidEnemies(bot, 24); return 0; }
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
