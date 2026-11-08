// fix93: one practice controller over every in-flight inference wait (composer and local).
// The last leave settles practice before the caller returns. A foreground body claims that
// settlement first, then may resume practice if a wait is still in flight.

export function createInferenceCover({ start, stop }) {
    if (typeof start !== 'function') throw new Error('[fix93] inference cover start required');
    if (typeof stop !== 'function') throw new Error('[fix93] inference cover stop required');
    let waits = 0;
    let active = null;
    let controllers = 0;
    const cover = {
        waits() { return waits; },
        controllers() { return controllers; },
        inflight() { return active !== null; },
        enter(callNum) {
            waits += 1;
            if (active !== null) return;
            controllers += 1;
            active = Promise.resolve().then(() => start(callNum));
        },
        async leave() {
            if (waits < 1) throw new Error('[fix93] inference cover leave without enter');
            waits -= 1;
            if (waits > 0) return;
            await cover._halt();
        },
        async claim() {
            await cover._halt();
        },
        async _halt() {
            if (active === null) return;
            const pending = active;
            active = null;
            stop();
            await pending;
        },
        resume(callNum) {
            if (waits < 1 || active !== null) return;
            controllers += 1;
            active = Promise.resolve().then(() => start(callNum));
        },
    };
    return cover;
}
