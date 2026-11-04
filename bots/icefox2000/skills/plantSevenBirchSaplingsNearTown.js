// Plant 7 birch saplings on grass_block or dirt within 25 blocks of (-1507, 542), spaced apart.
// DESCRIPTION: Plant 7 birch saplings on grass_block or dirt within 25 blocks of (-1507, 542), spaced apart.
async function plantSevenBirchSaplingsNearTown(bot) {
    const countSaplings = () => {
        const s = bot.inventory.items().find((i) => i.name === "birch_sapling");
        return s ? s.count : 0;
    };
    const centerX = -1507;
    const centerZ = 542;
    const maxDist = 25;
    const minSpacing = 3;
    const target = 7;
    const planted = [];

    if (countSaplings() < 1) {
        await bot.chat("No birch_sapling in inventory.");
        return;
    }

    const distXZ = (x, z) => Math.hypot(x - centerX, z - centerZ);
    const tooClose = (x, z) =>
        planted.some((p) => Math.hypot(p.x - x, p.z - z) < minSpacing);

    const candidates = [];
    for (let dx = -maxDist; dx <= maxDist; dx++) {
        for (let dz = -maxDist; dz <= maxDist; dz++) {
            const x = centerX + dx;
            const z = centerZ + dz;
            const d = distXZ(x, z);
            if (d > maxDist) continue;
            candidates.push({ x, z, d });
        }
    }
    candidates.sort((a, b) => a.d - b.d);

    for (const { x, z } of candidates) {
        if (planted.length >= target || countSaplings() < 1) break;
        if (tooClose(x, z)) continue;

        for (let y = 70; y >= 58; y--) {
            const floor = bot.blockAt(new Vec3(x, y, z));
            if (floor === null) continue;
            if (floor.name !== "grass_block" && floor.name !== "dirt") continue;

            const slot = bot.blockAt(new Vec3(x, y + 1, z));
            if (slot === null || slot.name !== "air") continue;
            const head = bot.blockAt(new Vec3(x, y + 2, z));
            if (head === null || head.name !== "air") continue;

            const ok = await skills.placeBlock(bot, "birch_sapling", x, y + 1, z, "bottom");
            if (ok) {
                planted.push({ x, z });
                await skills.wait(bot, 350);
                break;
            }
        }
    }

    await bot.chat(`Planted ${planted.length}/${target} birch saplings (saplings left: ${countSaplings()}).`);
}
