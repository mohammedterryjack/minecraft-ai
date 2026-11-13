import OpenAI from 'openai';

// Connection-class failures only. Classification uses the SDK/Node type or code,
// never a substring of the message, except the exact Node HTTP message below
// which is itself the signal when no code is set.
//
// Node common system errors (https://nodejs.org/api/errors.html#common-system-errors):
//   ECONNRESET, ECONNREFUSED, ETIMEDOUT, EHOSTUNREACH.
// The Node HTTP client reports a peer that closes the socket as message
// 'socket hang up', and that error's code is ECONNRESET. Match the exact
// message only when the code is absent.
//
// OpenAI Node SDK (https://github.com/openai/openai-node#handling-errors):
//   APIConnectionError is the N/A-status connection failure. A timeout throws
//   APIConnectionTimeoutError (README "Timeouts"), which extends it. 4xx/5xx
//   are other APIError subclasses and are not connection failures.
// The SDK puts the Node error on `cause` (openai/core.js). Walk that chain.
const APIConnectionError = OpenAI.APIConnectionError;
const APIConnectionTimeoutError = OpenAI.APIConnectionTimeoutError;

const CONNECTION_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH']);
const FAILOVER_LOG = '!!! [failover]';
const SPEC_FIELDS = new Set(['api', 'model', 'url', 'params', 'failover']);

function walkCauses(err, visit) {
    const seen = new Set();
    let current = err;
    while (current !== undefined && current !== null && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        visit(current);
        if (!Object.hasOwn(current, 'cause')) return;
        current = current.cause;
    }
}

// The most specific connection signal on the error or its cause chain, or
// undefined when the error is not a connection failure.
export function connectionErrorCode(err) {
    let systemCode;
    let hangup = false;
    let apiTimeout = false;
    let apiConnection = false;
    walkCauses(err, (current) => {
        if (systemCode === undefined && typeof current.code === 'string' && CONNECTION_CODES.has(current.code)) {
            systemCode = current.code;
        }
        if (current instanceof APIConnectionTimeoutError) apiTimeout = true;
        if (current instanceof APIConnectionError) apiConnection = true;
        if (current instanceof Error && current.message === 'socket hang up') hangup = true;
    });
    if (systemCode !== undefined) return systemCode;
    if (hangup) return 'socket hang up';
    if (apiTimeout) return 'APIConnectionTimeoutError';
    if (apiConnection) return 'APIConnectionError';
    return undefined;
}

export function isConnectionError(err) {
    return connectionErrorCode(err) !== undefined;
}

function requireConnectionCode(err) {
    const code = connectionErrorCode(err);
    if (code === undefined) throw new Error('[failover] connection classification lost its code');
    return code;
}

// Caught provider errors are rethrown with the original as `cause`. Callers
// must throw the result. A text substitute is not an error.
export function errorWithCause(err, message) {
    if (typeof message !== 'string' || message.length === 0) {
        throw new Error('[failover] errorWithCause requires a message');
    }
    if (err instanceof Error) return new Error(message, { cause: err });
    const cause = new Error('rejected with a non-Error value');
    cause.rejected = err;
    return new Error(message, { cause });
}

function specKind(spec) {
    if (spec === null) return 'null';
    if (Array.isArray(spec)) return 'array';
    return typeof spec;
}

function cloneModelSpecSeen(spec, label, seen) {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new Error(`[failover] ${label} is malformed (${specKind(spec)})`);
    }
    if (seen.has(spec)) throw new Error(`[failover] ${label} cycles`);
    seen.add(spec);
    for (const key of Object.keys(spec)) {
        if (!SPEC_FIELDS.has(key)) throw new Error(`[failover] ${label}.${key} is not a model-spec field`);
    }
    if (typeof spec.api !== 'string' || spec.api.length === 0) throw new Error(`[failover] ${label}.api is missing`);
    if (typeof spec.model !== 'string' || spec.model.length === 0) throw new Error(`[failover] ${label}.model is missing`);
    if (typeof spec.url !== 'string' || spec.url.length === 0) throw new Error(`[failover] ${label}.url is missing`);
    const copy = { api: spec.api, model: spec.model, url: spec.url };
    if (Object.hasOwn(spec, 'params')) {
        if (spec.params === null || typeof spec.params !== 'object' || Array.isArray(spec.params)) {
            throw new Error(`[failover] ${label}.params is malformed`);
        }
        copy.params = { ...spec.params };
    }
    if (Object.hasOwn(spec, 'failover')) {
        copy.failover = cloneModelSpecSeen(spec.failover, `${label}.failover`, seen);
    }
    return copy;
}

// Copy a declared model spec so selectAPI / JSON mode can mutate the copy
// without rewriting the profile object the caller still holds.
export function cloneModelSpec(spec, label) {
    return cloneModelSpecSeen(spec, label, new Set());
}

function describe(model) {
    if (model === undefined || model === null) throw new Error('[failover] model is missing');
    const name = model.model_name;
    const url = model.url;
    if (typeof name !== 'string' || name.length === 0) throw new Error('[failover] model_name is missing');
    if (typeof url !== 'string' || url.length === 0) throw new Error(`[failover] ${name} url is missing`);
    return `${name} at ${url}`;
}

function errorSignal(err) {
    const code = connectionErrorCode(err);
    if (code !== undefined) return code;
    if (err instanceof Error) return err.message;
    return String(err);
}

function bothFailed(primary, failover, primaryErr, failoverErr) {
    const message = `${FAILOVER_LOG} ${describe(primary)} failed (${errorSignal(primaryErr)}) and ${describe(failover)} failed (${errorSignal(failoverErr)})`;
    console.error(message);
    const err = new AggregateError([primaryErr, failoverErr], message);
    err.cause = primaryErr;
    return err;
}

// One wrapper for every model createModel builds. Recovery probes the primary
// on the next call: there is no cooldown constant. A successful primary call
// is the recovery. A connection failure stays on the failover. Any other
// primary error propagates and does not call the failover.
export class FailoverModel {
    constructor(primary, failover) {
        if (primary === undefined || primary === null) throw new Error('[failover] primary model is missing');
        if (failover === undefined || failover === null) throw new Error('[failover] failover model is missing');
        describe(primary);
        describe(failover);
        this.primary = primary;
        this.failover = failover;
        this.model_name = primary.model_name;
        this.url = primary.url;
        this.params = primary.params;
        this.onFailover = false;
    }

    sendRequest(...args) {
        return this._dispatch('sendRequest', args);
    }

    sendVisionRequest(...args) {
        return this._dispatch('sendVisionRequest', args);
    }

    embed(...args) {
        return this._dispatch('embed', args);
    }

    async _invoke(model, method, args) {
        const fn = model[method];
        if (typeof fn !== 'function') throw new Error(`[failover] ${describe(model)} has no ${method}`);
        return await fn.apply(model, args);
    }

    async _dispatch(method, args) {
        if (this.onFailover) {
            let probeErr;
            try {
                const result = await this._invoke(this.primary, method, args);
                this.onFailover = false;
                console.error(`${FAILOVER_LOG} primary recovered ${describe(this.primary)}`);
                return result;
            } catch (err) {
                if (!isConnectionError(err)) throw err;
                probeErr = err;
                console.error(`${FAILOVER_LOG} ${describe(this.primary)} still unreachable (${requireConnectionCode(err)}); staying on ${describe(this.failover)}`);
            }
            try {
                return await this._invoke(this.failover, method, args);
            } catch (failoverErr) {
                throw bothFailed(this.primary, this.failover, probeErr, failoverErr);
            }
        }
        try {
            return await this._invoke(this.primary, method, args);
        } catch (err) {
            if (!isConnectionError(err)) throw err;
            const code = requireConnectionCode(err);
            console.error(`${FAILOVER_LOG} switching ${describe(this.primary)} -> ${describe(this.failover)} after ${code}`);
            this.onFailover = true;
            try {
                return await this._invoke(this.failover, method, args);
            } catch (failoverErr) {
                throw bothFailed(this.primary, this.failover, err, failoverErr);
            }
        }
    }
}
