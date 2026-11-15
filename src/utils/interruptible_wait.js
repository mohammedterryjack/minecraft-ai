// fix120: make bot.waitForTicks honor mindcraft's interrupt flag.
//
// mineflayer's bot.waitForTicks (lib/bot.js) waits raw physics ticks and knows nothing about
// bot.interrupt_code. The generated-code guards _stageCode inserts after statements
// (`if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}`, coder.js:852) can only
// run once the await they precede resolves — so a long tick wait is an uninterruptible island.
// Live 15 Nov 2026 21:00 GMT: the bot took lethal damage inside a long waitForTicks during a
// replayed task; agent.requestInterrupt set interrupt_code and cancelled the pathfinder/pvp/dig
// tasks, but the tick wait ran to its end; action_manager.stop() escalated after 10 seconds
// ("Code execution refused to stop after 10 seconds", action_manager.js:46) and cleanKilled the
// process — a full bot restart for an interrupt that should have unwound in one tick.
//
// Convention (not invented here): an interrupted wait resolves rather than rejects, exactly like
// the endowed library calls (coder.js:1225 wraps them as `interrupt_code ? Promise.resolve(false)
// : f(...)`), so the statement guard after the await is what ends the code.
//
// The interrupt source is agent.requestInterrupt (agent.js), which sets bot.interrupt_code and
// emits 'interrupt_code_set'; this wrapper listens for that event while a wait is outstanding.
export function installInterruptibleWaitForTicks(bot) {
    if (bot.__interruptibleWaitInstalled) return;
    // waitForTicks is a PROTOTYPE method in mineflayer (lib/bot.js: Bot.prototype.waitForTicks),
    // so it is never an own property right after createBot; check the lookup, then wrap as an
    // own property that calls the prototype original via `orig.call(this, ticks)`.
    if (typeof bot.waitForTicks !== 'function') throw new Error('[fix120] bot.waitForTicks is not callable at install time');
    const orig = bot.waitForTicks;
    bot.waitForTicks = function (ticks) {
        if (bot.interrupt_code) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const onInterrupt = () => {
                bot.removeListener('interrupt_code_set', onInterrupt);
                resolve();
            };
            bot.on('interrupt_code_set', onInterrupt);
            orig.call(this, ticks).then(
                () => { bot.removeListener('interrupt_code_set', onInterrupt); resolve(); },
                (err) => { bot.removeListener('interrupt_code_set', onInterrupt); reject(err); }
            );
        });
    };
    bot.__interruptibleWaitInstalled = true;
}
