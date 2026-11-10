/**
 * Proxies `bot` so each call to an own or prototype method can log duration until return / promise settlement.
 * Context: bot.__psnStackStr (set in skill_graph instrumentSrc __wrap).
 *
 * Root cause of live spam (`[bot-api] blockAt 0ms ctx=(no PSN trace)` on every call):
 * logging was unconditional. fix57 compared each call with the keep-alive gap, and fix99
 * then pointed that field at the 30000 ms kick bound. A call is logged when it takes longer
 * than every earlier completed call of the same method. The store is the recorded durations.
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

// findBlocks options that must be finite numbers. The lint reads this list; it is not a second table of call shapes.
export const FIND_BLOCKS_NUMERIC_OPTIONS = ['maxDistance', 'count'];

// fix97: findBlocks used `options.maxDistance || 16` and `options.count || 1`. An array is truthy, so it was kept,
// and the scan's (maxDistance + 8) became a string. A length-2 array makes that NaN and the section iterator never ends.
// findBlock returns one block and does not take count; the patched function passes count 1 itself.
export function assertFindBlocksOptions(options, fnName) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error(`${fnName}: options object required, got ${options === null ? 'null' : Array.isArray(options) ? JSON.stringify(options) : typeof options}`);
    }
    const required = fnName === 'findBlock' ? ['maxDistance'] : FIND_BLOCKS_NUMERIC_OPTIONS;
    const present = fnName === 'findBlock' ? FIND_BLOCKS_NUMERIC_OPTIONS.filter(key => Object.hasOwn(options, key)) : required;
    const keys = required.concat(present.filter(key => !required.includes(key)));
    for (const key of keys) {
        if (!Object.hasOwn(options, key) || typeof options[key] !== 'number' || !Number.isFinite(options[key])) {
            const v = options[key];
            const shown = v === undefined ? 'undefined' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
            throw new Error(`${fnName}: ${key} must be a finite number, got ${shown}. matching is a block id, an array of block ids, or a function; maxDistance and count are numbers`);
        }
    }
}

// Completed call durations, per method. The owner (voyager progress.botApiDurations) attaches the store.
// A missing store is not an empty one: there is nothing to compare a call with.
let _durations = null;
export function setBotApiDurationStore(store) {
    if (!store || typeof store !== 'object' || Array.isArray(store)) {
        throw new Error('[bot-api] duration store must be an object');
    }
    _durations = store;
}
export function botApiDurationStore() { return _durations; }
export function _clearBotApiDurationStoreForTest() { _durations = null; }

// Record this completed call. Returns the previous maximum when this call is longer than every
// earlier completed call of the same method, otherwise null. The first call of a method has no
// earlier call, so it is recorded and not an excess.
export function noteBotApiDuration(name, ms) {
    if (!_durations) throw new Error('[bot-api] duration store is not attached; a call is compared with recorded durations of the same method');
    if (typeof name !== 'string' || name.length === 0) throw new Error('[bot-api] method name required');
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new Error(`[bot-api] duration of ${name} is ${ms}`);
    const prev = _durations[name];
    const bound = prev && prev.n > 0 ? prev.max : null;
    const earlier = prev && prev.n > 0 ? prev.n : 0;
    const rec = prev ? prev : { n: 0, max: 0 };
    rec.n += 1;
    if (ms > rec.max) rec.max = ms;
    _durations[name] = rec;
    if (bound === null || ms <= bound) return null;
    return { max: bound, n: earlier };
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
                if (prop === 'findBlocks' || prop === 'findBlock') assertFindBlocksOptions(args[0], String(prop));
                const t0 = Date.now();
                const done = () => {
                    const ms = Date.now() - t0;
                    const over = noteBotApiDuration(String(prop), ms);
                    if (!over) return;
                    const ctx = tr.__psnStackStr != null ? String(tr.__psnStackStr) : '(no PSN trace)';
                    console.log(`[bot-api] ${String(prop)} ${ms}ms exceeds the longest recorded ${String(prop)} call (${over.max}ms across ${over.n} call(s)) ctx=${ctx}`);
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
