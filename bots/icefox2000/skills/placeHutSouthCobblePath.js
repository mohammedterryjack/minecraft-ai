// Place four cobblestone blocks at (-1506,63,z) for z=544..547 and verify exactly four were used.
// DESCRIPTION: Place four cobblestone blocks at (-1506,63,z) for z=544..547 and verify exactly four were used.
async function placeHutSouthCobblePath(bot) {
    const countCobble = () => {
        const stack = bot.inventory.items().find((i) => i.name === 'cobblestone');
        return stack ? stack.count : 0;
    };

    const pathX = -1506;
    const pathY = 63;
    const zs = [544, 545, 546, 547];

    if (bot.interrupt_code) return;
    if (countCobble() < 4) {
        await bot.chat(`Need 4 cobblestone; have ${countCobble()}.`);
        return;
    }

    const cobbleBefore = countCobble();
    const p = world.getPosition(bot);
    if (Math.abs(p.x - pathX) > 2 || Math.abs(p.y - pathY) > 2 || Math.abs(p.z - zs[0]) > 4) {
        if (bot.interrupt_code) return;
        await skills.goToPosition(bot, pathX + 1, pathY, zs[0]);
        if (bot.interrupt_code) return;
        await skills.wait(bot, 500);
    }

    for (let i = 0; i < zs.length; i++) {
        if (bot.interrupt_code) return;
        const z = zs[i];
        const target = bot.blockAt(new Vec3(pathX, pathY, z));
        if (target && target.name === 'cobblestone') continue;
        if (target && target.name !== 'air') {
            await bot.chat(`Blocked at z=${z}: ${target.name}`);
            continue;
        }

        const floor = bot.blockAt(new Vec3(pathX, pathY - 1, z));
        if (!floor || floor.name === 'air' || floor.name === 'water') {
            await bot.chat(`No floor at z=${z}; skip.`);
            continue;
        }

        await skills.goToPosition(bot, pathX + 1, pathY, z);
        if (bot.interrupt_code) return;
        await skills.wait(bot, 400);

        let placed = await skills.placeBlock(bot, 'cobblestone', pathX, pathY, z, 'west');
        if (bot.interrupt_code) return;
        if (!placed) placed = await skills.placeBlock(bot, 'cobblestone', pathX, pathY, z, 'top');
        if (bot.interrupt_code) return;
        if (!placed) {
            await skills.goToPosition(bot, pathX, pathY, z + 1);
            if (bot.interrupt_code) return;
            placed = await skills.placeBlock(bot, 'cobblestone', pathX, pathY, z, 'north');
        }
        if (bot.interrupt_code) return;
        if (!placed) await bot.chat(`placeBlock FAILED z=${z}`);
        await skills.wait(bot, 200);
    }

    if (bot.interrupt_code) return;
    let allCobble = true;
    for (let j = 0; j < zs.length; j++) {
        const b = bot.blockAt(new Vec3(pathX, pathY, zs[j]));
        if (!b || b.name !== 'cobblestone') allCobble = false;
    }
    const used = cobbleBefore - countCobble();
    await bot.chat(
        allCobble && used === 4
            ? 'Path OK: 4 cobble at y=63 x=-1506 z=544..547.'
            : `Path verify FAIL allCobble=${allCobble} cobble_used=${used}/4.`
    );
}
