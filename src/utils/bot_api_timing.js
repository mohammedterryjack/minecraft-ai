/**
 * Proxies `bot` so each call to an own or prototype method can log duration until return / promise settlement.
 * Context: bot.__psnStackStr (set in skill_graph instrumentSrc __wrap).
 *
 * Root cause of live spam (`[bot-api] blockAt 0ms ctx=(no PSN trace)` on every call):
 * logging was unconditional. Log only when duration exceeds
 * bot.__eventLoopStallThresholdMs, the keep-alive kick bound the stall guard sets at start.
 * No log until that bound is set.
 */
import { mainThreadWatchdogStarted, noteMainThreadCall } from './main_thread_watchdog.js';

// fix96: one argument as the kill evidence shows it: primitives as they are, a function as its name, an object by its
// own primitive fields (a Vec3 is x,y,z; findBlocks options show maxDistance and count). Nothing is stringified deeply,
// so a bot or a block (cyclic, large) costs no more than its own keys.
export function describeApiArg(a) {
    if (a === null || a === undefined) return String(a);
    if (typeof a === 'function') return `fn ${a.name ? a.name : '(anonymous)'}`;
    if (typeof a !== 'object') return JSON.stringify(a);
    if (Array.isArray(a)) return `[${a.map(x => (x !== null && typeof x === 'object' ? 'obj' : describeApiArg(x))).join(',')}]`;
    const fields = [];
    for (const k of Object.keys(a)) {
        const v = a[k];
        if (v === null || typeof v !== 'object') fields.push(`${k}:${describeApiArg(v)}`);
        else if (Array.isArray(v)) fields.push(`${k}:[${v.length}]`);
    }
    return `{${fields.join(',')}}`;
}

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
                        // The stall guard has not set the keep-alive kick bound yet; nothing to compare.
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
                // fix96: the watchdog worker reads this while the main thread is blocked inside the call
                const noted = mainThreadWatchdogStarted();
                if (noted) noteMainThreadCall(`${String(prop)}(${args.map(describeApiArg).join(', ')}) ctx=${tr.__psnStackStr != null ? String(tr.__psnStackStr) : '(no PSN trace)'}`);
                try {
                    ret = raw.apply(tr, args);
                } catch (e) {
                    if (noted) noteMainThreadCall('');
                    done();
                    throw e;
                }
                if (noted) noteMainThreadCall('');
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
