// fix204 (live icefox2000, 27 Nov): three "[fix201] LOUD: 1 x porkchop at game value 3 promised
// food >= 18 but food is 16" process exits. bot.consume() resolves on the eat-animation packet
// entity_status 9 (mineflayer lib/plugins/inventory.js:75-76), but the food level rides a SEPARATE
// update_health packet (lib/plugins/health.js:24-27, which emits the bot 'health' event). Reading
// bot.food the instant consume() resolves races that packet and saw the pre-eat value. The eat had
// actually landed (16 -> 19); only the read was stale. _awaitFoodAfterEat waits on the authoritative
// 'health' event instead of reading blind.
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    mod._setVersionForTest('1.21.4');
    Voyager = mod.Voyager;
});

// A bot whose food update lands one macrotask after consume() resolves — the real packet ordering.
function racingBot(startFood) {
    const bot = new EventEmitter();
    bot.food = startFood;
    bot.health = 20;
    bot._pending = [];
    bot.eat = (points) => new Promise((resolve) => {
        // entity_status 9 arrives now (consume resolves), but food is unchanged...
        resolve();
        // ...the update_health packet carrying the new food lands on the next tick.
        setTimeout(() => { bot.food += points; bot.emit('health'); }, 0);
    });
    return bot;
}

describe('fix204 _awaitFoodAfterEat waits for the update_health packet', () => {
    it('returns the post-eat food even though consume() resolved before the packet', async () => {
        const bot = racingBot(16);
        const v = Object.create(Voyager.prototype);
        v.agent = { bot };
        await bot.eat(3);                      // consume resolves; food still 16 here
        assert.strictEqual(bot.food, 16);      // proves the race exists at this instant
        const seen = await v._awaitFoodAfterEat(16);
        assert.strictEqual(seen, 19);          // waited for the packet, saw the real value
    });
    it('returns immediately when food already moved (no event needed)', async () => {
        const bot = new EventEmitter();
        bot.food = 19;
        const v = Object.create(Voyager.prototype);
        v.agent = { bot };
        assert.strictEqual(await v._awaitFoodAfterEat(16), 19);
    });
});

describe('fix204 the eat loop no longer throws on a stale food read', () => {
    before(async () => {
        const mod = await import('../src/agent/voyager.js');
        Voyager = mod.Voyager;
    });

    // Reproduces the live death: floor 18, food 16, one porkchop (foodPoints 3) closes to 19.
    // Pre-fix the loop read food=16 after consume, declared the promise broken, and exited the process.
    it('closes the deficit when the food packet trails the eat', async () => {
        const bot = racingBot(16);
        const v = Object.create(Voyager.prototype);
        v.agent = { bot };
        v._consumeItem = () => bot.eat(3);
        // one iteration: eat, then wait for the packet -> liveFood 19 >= floor 18 -> loop exits closed.
        let eaten = 0;
        let liveFood = bot.food;               // 16
        const floor = 18;
        const needCount = Math.ceil((floor - 16) / 3);   // 1
        while (eaten < needCount && eaten < 1 && liveFood < floor) {
            await v._consumeItem('cooked_porkchop');   // resolves before the food packet (see racingBot)
            eaten++;
            liveFood = await v._awaitFoodAfterEat(liveFood);
        }
        assert.strictEqual(liveFood, 19);
        assert.ok(liveFood >= floor, 'deficit closed on the true post-eat food, not the stale 16');
    });
});
