/**
 * Proxies `bot` so each call to an own or prototype method logs duration until return / promise settlement.
 * Context: bot.__psnStackStr (set in skill_graph instrumentSrc __wrap).
 */
export function wrapBotForApiTiming(bot) {
    if (!bot) throw new Error('[bot_api_timing] bot is required');
    if (bot.__isBotApiTimingProxy === true) return bot;
    if (bot.__botApiTimingProxy) return bot.__botApiTimingProxy;
    const target = bot;
    const proxy = new Proxy(target, {
        get(tr, prop, receiver) {
            const raw = Reflect.get(tr, prop, receiver);
            if (typeof prop === 'symbol' || prop === 'then' || prop === 'catch' || prop === 'finally') return raw;
            if (typeof raw !== 'function') return raw;
            return function timedBotApi(...args) {
                const t0 = Date.now();
                const ctx = tr.__psnStackStr != null ? String(tr.__psnStackStr) : '(no PSN trace)';
                const done = () => {
                    const ms = Date.now() - t0;
                    console.log(`[bot-api] ${String(prop)} ${ms}ms ctx=${ctx}`);
                };
                let ret;
                try {
                    ret = raw.apply(tr, args);
                } catch (e) {
                    done();
                    throw e;
                }
                if (ret && typeof ret.then === 'function') {
                    return ret.then(
                        (v) => {
                            done();
                            return v;
                        },
                        (e) => {
                            done();
                            throw e;
                        }
                    );
                }
                done();
                return ret;
            };
        },
    });
    Object.defineProperty(proxy, '__isBotApiTimingProxy', { value: true, enumerable: false, configurable: true });
    Object.defineProperty(target, '__botApiTimingProxy', { value: proxy, enumerable: false, configurable: true });
    return proxy;
}
