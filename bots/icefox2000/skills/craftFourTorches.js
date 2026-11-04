// Go to the crafting table within 15 blocks of (-1507,542), craft torches from 1 coal and 1 stick, pick up output, and verify counts.
// DESCRIPTION: Go to the crafting table within 15 blocks of (-1507,542), craft torches from 1 coal and 1 stick, pick up output, and verify counts.
async function craftFourTorches(bot) {
    const itemCount = (name) => {
        const stack = bot.inventory.items().find((i) => i.name === name);
        return stack ? stack.count : 0;
    };
    const countTorches = () =>
        bot.inventory.items().filter((i) => i.name === 'torch').reduce((s, i) => s + i.count, 0);

    const beforeCoal = itemCount('coal');
    const beforeStick = itemCount('stick');
    const beforeTorch = countTorches();
    if (beforeCoal < 1 || beforeStick < 1) return;

    await skills.defendSelf(bot, 12);

    const targetX = -1507;
    const targetZ = 542;
    const maxDistSq = 15 * 15;
    const tableId = bot.registry.blocksByName.crafting_table.id;

    let table = null;
    const candidates = bot.findBlocks({ matching: tableId, maxDistance: 32, count: 20 });
    for (const p of candidates) {
        const dx = p.x - targetX;
        const dz = p.z - targetZ;
        if (dx * dx + dz * dz <= maxDistSq) {
            const b = bot.blockAt(p);
            if (b) {
                table = b;
                break;
            }
        }
    }
    if (!table) return;

    const tx = table.position.x;
    const ty = table.position.y;
    const tz = table.position.z;
    const spots = [
        [tx, ty + 1, tz + 1],
        [tx + 1, ty + 1, tz],
        [tx, ty + 1, tz - 1],
        [tx - 1, ty + 1, tz],
        [tx, ty + 1, tz]
    ];
    for (const [sx, sy, sz] of spots) {
        const feet = bot.blockAt(new Vec3(sx, sy - 1, sz));
        const head = bot.blockAt(new Vec3(sx, sy, sz));
        if (feet && feet.boundingBox === 'block' && head && (head.name === 'air' || head.name === 'crafting_table')) {
            await skills.goToPosition(bot, sx, sy, sz);
            await skills.wait(bot, 700);
            if (bot.entity.position.distanceTo(table.position) <= 4.5) break;
        }
    }

    await skills.craftRecipe(bot, 'torch');
    await skills.wait(bot, 1500);

    for (let i = 0; i < 12 && countTorches() < beforeTorch + 4; i++) {
        await skills.pickupNearbyItems(bot);
        await skills.wait(bot, 350);
    }

    const gained = countTorches() - beforeTorch;
    const coalUsed = beforeCoal - itemCount('coal');
    const stickUsed = beforeStick - itemCount('stick');
    if (gained < 4 && coalUsed === 0 && stickUsed === 0) {
        await skills.craftRecipe(bot, 'torch');
        await skills.wait(bot, 1500);
        for (let i = 0; i < 8; i++) {
            await skills.pickupNearbyItems(bot);
            await skills.wait(bot, 350);
        }
    }
}
