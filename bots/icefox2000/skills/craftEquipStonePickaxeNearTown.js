// Craft one stone pickaxe at the crafting table within 15 blocks of (-1507,542), verify cobble/stick consumption and inventory, then equip main hand.
// DESCRIPTION: Craft one stone pickaxe at the crafting table within 15 blocks of (-1507,542), verify cobble/stick consumption and inventory, then equip main hand.
async function craftEquipStonePickaxeNearTown(bot) {
    const itemCount = (name) => {
        const stack = bot.inventory.items().find((i) => i.name === name);
        return stack ? stack.count : 0;
    };

    const existingPick = bot.inventory.items().find((i) => i.name === 'stone_pickaxe');
    if (existingPick) {
        await bot.equip(existingPick, 'hand');
        return;
    }

    if (itemCount('cobblestone') < 3 || itemCount('stick') < 2) return;

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
        [tx, ty + 1, tz + 1],
    ];
    for (const [sx, sy, sz] of spots) {
        const feet = bot.blockAt(new Vec3(sx, sy - 1, sz));
        const head = bot.blockAt(new Vec3(sx, sy, sz));
        if (feet && feet.boundingBox === 'block' && head && (head.name === 'air' || head.name === 'short_grass')) {
            await skills.goToPosition(bot, sx, sy, sz);
            await skills.wait(bot, 800);
            if (bot.entity.position.distanceTo(table.position) <= 4.5) break;
        }
    }

    const stickStack = bot.inventory.items().find((i) => i.name === 'stick');
    if (stickStack) await bot.equip(stickStack, 'hand');

    for (let attempt = 0; attempt < 4 && itemCount('stone_pickaxe') < 1; attempt++) {
        const beforeCobble = itemCount('cobblestone');
        const beforeStick = itemCount('stick');
        if (beforeCobble < 3 || beforeStick < 2) break;

        const opened = await goToBlockAndInteract(bot, 'crafting_table', 16);
        if (!opened) {
            await skills.goToNearestBlock(bot, 'crafting_table', 2, 16);
            await skills.wait(bot, 500);
            continue;
        }

        await skills.wait(bot, 400);
        await skills.craftRecipe(bot, 'stone_pickaxe');
        await skills.wait(bot, 1500);

        for (let i = 0; i < 12 && itemCount('stone_pickaxe') < 1; i++) {
            await collectDrops(bot);
            await skills.wait(bot, 400);
        }

        const afterPick = itemCount('stone_pickaxe');
        const cobbleDelta = beforeCobble - itemCount('cobblestone');
        const stickDelta = beforeStick - itemCount('stick');
        if (afterPick >= 1 && cobbleDelta === 3 && stickDelta === 2) break;

        if (afterPick >= 1 && (cobbleDelta !== 3 || stickDelta !== 2)) break;
    }

    const pick = bot.inventory.items().find((i) => i.name === 'stone_pickaxe');
    if (pick) await bot.equip(pick, 'hand');
}
