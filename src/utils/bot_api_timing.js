/**
 * Proxies `bot` so each call to an own or prototype method can log duration until return / promise settlement.
 * Context: bot.__psnStackStr (set in skill_graph instrumentSrc __wrap).
 *
 * Root cause of live spam (`[bot-api] blockAt 0ms ctx=(no PSN trace)` on every call):
 * logging was unconditional. Log only when duration exceeds the learned
 * bot.__eventLoopStallThresholdMs (same keep_alive-derived threshold as the event-loop guard).
 * No new constants; no log until that threshold is learned.
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
                const done = () => {
                    const ms = Date.now() - t0;
                    const thr = tr.__eventLoopStallThresholdMs;
                    if (thr === undefined || thr === null) {
                        // Not learned yet (need two inbound keep_alive packets); nothing to compare.
                        return;
                    }
                    if (typeof thr !== 'number' || !Number.isFinite(thr) || thr <= 0) {
                        throw new Error(
                            '[bot_api_timing] __eventLoopStallThresholdMs must be a positive finite number when set'
                        );
                    }
                    if (ms <= thr) return;
                    const ctx = tr.__psnStackStr != null ? String(tr.__psnStackStr) : '(no PSN trace)';
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
