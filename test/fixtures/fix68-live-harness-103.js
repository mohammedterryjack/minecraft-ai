    const __T = bot.__psnTrace = []; const __als = bot.__psnALS; if (!__als) throw new Error('PSN trace: bot.__psnALS (AsyncLocalStorage) missing'); const __inv = () => getInventoryCounts(bot); if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
    const __eq = () => { const s = bot.inventory.slots; return { heldItem: s[bot.quickBarSlot + 36]?.name || null, offHand: s[45]?.name || null, helmet: s[5]?.name || null, chestplate: s[6]?.name || null, leggings: s[7]?.name || null, boots: s[8]?.name || null }; }; if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
    const __have = () => __inv(); if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
    const __st = () => { const p = bot.entity.position, b = bot.blockAt(p.floored().offset(0, 1, 0)); return { pos: { x: p.x, y: p.y, z: p.z }, hp: bot.health, food: bot.food, oxygen: bot.oxygenLevel, sky: b ? b.skyLight : null, alive: bot.health > 0, dim: String(bot.game?.dimension || ''), inv: __inv(), free: bot.inventory.emptySlotCount(), eq: __eq() }; }; if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
    const __wrap = (n, f) => async function (...a) {
        if (__T.length >= 1500) return await f.apply(this, a); if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
        const par = __als.getStore() ?? -1; if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
        const __stackParts = []; for (let __i = par; __i >= 0 && __i < __T.length; __i = __T[__i].parent) { await __loopTurn__(); __stackParts.push(__T[__i].name); } const __stackStr = [...__stackParts.reverse(), n].join(' <- '); if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
        bot.__psnRunningSkill = n; bot.__psnStackStr = __stackStr; if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
        const rec = { name: n, args: (() => { const s = a.slice(1); return JSON.stringify(s).slice(0, 120); })(), parent: par, depth: par < 0 ? 0 : __T[par].depth + 1, o0: (bot.output || '').length, t0: Date.now(), pre: __have(), argv: a.slice(1).map(x => x === null || typeof x !== 'object' ? x : null) }; if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
        if (!n.startsWith('skills.')) rec.s0 = __st(); if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
        const id = __T.push(rec) - 1; if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
        try { const r = await __als.run(id, () => f.apply(this, a)); rec.ret = r === undefined ? 'undefined' : String(JSON.stringify(r)).slice(0, 60); rec.rv = r === null || typeof r !== 'object' ? r : null; rec.fail = r === false || r === null || r === 0; return r; }
        catch (e) {
            rec.fail = true; if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
            const msg = String(e?.message || e); if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
            rec.err = msg; if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
            bot.output = bot.output + '\nFAILED: ' + n + ' threw ' + msg + '\n'; if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
            rec.rv = false; if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
            return false; if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
        }
        finally { await bot.waitForTicks(1); rec.t1 = Date.now(); if (!n.startsWith('skills.')) rec.s1 = __st(); rec.o1 = (bot.output || '').length; bot.__psnOut = bot.output; const post = __have(); rec.delta = {}; for (const k of new Set([...Object.keys(rec.pre), ...Object.keys(post)])) { await __loopTurn__(); const d = (post[k] || 0) - (rec.pre[k] || 0); if (d) rec.delta[k] = d; } delete rec.pre; rec.intr = !!bot.interrupt_code; bot.__psnRunningSkill = par >= 0 ? __T[par].name : null; bot.__psnStackStr = __stackParts.join(' <- '); }
    }; if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}
