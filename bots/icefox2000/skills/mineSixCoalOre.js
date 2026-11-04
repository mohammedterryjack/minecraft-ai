// Mine coal_ore near town until inventory coal increases by 6, prioritizing nearby ore and repeated pickups after each break.
// DESCRIPTION: Mine coal_ore near town until inventory coal increases by 6, prioritizing nearby ore and repeated pickups after each break.
async function mineSixCoalOre(bot) {
    await skills.equip(bot, 'iron_pickaxe');

    const countCoal = () => {
        const stack = bot.inventory.items().find(i => i.name === 'coal');
        return stack ? stack.count : 0;
    };

    const startCoal = countCoal();
    const needCoal = startCoal + 6;
    const coalOreId = bot.registry.blocksByName.coal_ore.id;
    const anchorX = -1507;
    const anchorY = 63;
    const anchorZ = 542;

    const nearTown = (pos) => {
        if (Math.abs(pos.x - (-800)) < 100 && Math.abs(pos.z - 500) < 100) return false;
        const dx = pos.x - anchorX;
        const dy = pos.y - anchorY;
        const dz = pos.z - anchorZ;
        return dx * dx + dy * dy + dz * dz <= 150 * 150;
    };

    const pickupCoalDrops = async () => {
        for (let i = 0; i < 6; i++) {
            await skills.pickupNearbyItems(bot);
            await skills.wait(bot, 350);
            if (countCoal() >= needCoal) break;
        }
    };

    let breakAttempts = 0;
    const maxBreakAttempts = 40;
    let oreBreaks = 0;

    while (countCoal() < needCoal && breakAttempts < maxBreakAttempts) {
        const botPos = bot.entity.position;
        const coalPositions = bot
            .findBlocks({ matching: coalOreId, maxDistance: 48, count: 32 })
            .filter(nearTown)
            .sort((a, b) => {
                const da =
                    (a.x - botPos.x) ** 2 + (a.y - botPos.y) ** 2 + (a.z - botPos.z) ** 2;
                const db =
                    (b.x - botPos.x) ** 2 + (b.y - botPos.y) ** 2 + (b.z - botPos.z) ** 2;
                return da - db;
            });

        if (coalPositions.length === 0) {
            await pickupCoalDrops();
            if (countCoal() >= needCoal) break;
            await skills.wait(bot, 500);
            break;
        }

        let progressed = false;
        for (const pos of coalPositions) {
            if (countCoal() >= needCoal) break;
            if (oreBreaks >= 6 && countCoal() >= needCoal) break;

            breakAttempts++;
            const beforeBreak = countCoal();
            if (await skills.breakBlockAt(bot, pos.x, pos.y, pos.z)) {
                oreBreaks++;
                progressed = true;
                await skills.wait(bot, 400);
                await pickupCoalDrops();
                if (countCoal() === beforeBreak && oreBreaks < 6) {
                    await skills.wait(bot, 600);
                    await pickupCoalDrops();
                }
            }

            if (countCoal() >= needCoal) break;
        }

        if (!progressed) {
            await pickupCoalDrops();
            if (countCoal() >= needCoal) break;
            await skills.wait(bot, 500);
            break;
        }
    }

    await pickupCoalDrops();
}
