// Walk to grass_block near town and plant one birch_sapling on clear grass within 25 blocks of (-1507, 542).
// DESCRIPTION: Walk to grass_block near town and plant one birch_sapling on clear grass within 25 blocks of (-1507, 542).
async function plantOneBirchSaplingNearTown(bot) {
    const centerX = -1507;
    const centerZ = 542;
    const maxDist = 25;

    const saplingCount = () => {
        const s = bot.inventory.items().find((i) => i.name === "birch_sapling");
        return s ? s.count : 0;
    };
    if (saplingCount() < 1) {
        await bot.chat("No birch_sapling in inventory.");
        return;
    }

    const distXZ = (x, z) => Math.hypot(x - centerX, z - centerZ);

    // Path near plantable grass (hint: ~-1506, 63, 546)
    const walked = await goToBlockAndInteract(bot, "grass_block", maxDist);
    if (!walked) {
        await skills.goToPosition(bot, -1506, 63, 546);
    }
    await skills.wait(bot, 500);

    const grassId = bot.registry.blocksByName.grass_block.id;
    const found = bot.findBlocks({ matching: grassId, maxDistance: maxDist + 8, count: 60 });
    const candidates = [];

    for (const p of found) {
        if (distXZ(p.x, p.z) > maxDist) continue;
        const floor = bot.blockAt(p);
        if (floor === null || floor.name !== "grass_block") continue;
        const slot = bot.blockAt(p.offset(0, 1, 0));
        if (slot === null || slot.name !== "air") continue;
        const head = bot.blockAt(p.offset(0, 2, 0));
        if (head === null || head.name !== "air") continue;
        const below = bot.blockAt(p.offset(0, -1, 0));
        if (below !== null && below.name === "water") continue;
        candidates.push({ x: p.x, y: p.y, z: p.z, d: distXZ(p.x, p.z) });
    }
    candidates.sort((a, b) => a.d - b.d);

    for (const { x, y, z } of candidates) {
        if (saplingCount() < 1) break;
        await skills.goToPosition(bot, x + 0.5, y + 1, z + 0.5);
        await skills.wait(bot, 450);

        const floor = bot.blockAt(new Vec3(x, y, z));
        const slot = bot.blockAt(new Vec3(x, y + 1, z));
        if (floor === null || floor.name !== "grass_block") continue;
        if (slot === null || slot.name !== "air") continue;

        const sap = bot.inventory.items().find((i) => i.name === "birch_sapling");
        if (sap) await bot.equip(sap, "hand");

        const ok = await skills.placeBlock(bot, "birch_sapling", x, y + 1, z, "bottom");
        if (ok) {
            await bot.chat(`Planted birch_sapling at ${x},${y + 1},${z} (left: ${saplingCount()}).`);
            return;
        }
    }

    await bot.chat("FAILED: could not plant birch_sapling on grass_block in range.");
}
