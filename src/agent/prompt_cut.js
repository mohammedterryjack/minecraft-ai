// fix93: the voyager code-model system prompt keeps the instruction prose and drops the
// placeholders the user message already carries (stats, inventory, docs, examples, memory, self-prompt).
// Those expansions were a second, stale copy of the same facts.

const REDUNDANT = ['$SELF_PROMPT', '$MEMORY', '$STATS', '$INVENTORY', '$CODE_DOCS', '$EXAMPLES'];

export function voyagerCodingInstructions(coding, name) {
    if (typeof coding !== 'string' || coding.length === 0) throw new Error('[fix93] profile.coding required');
    for (const marker of REDUNDANT) {
        if (!coding.includes(marker)) throw new Error(`[fix93] profile.coding has no ${marker}; the redundant expansion cannot be cut`);
    }
    let first = coding.length;
    for (const marker of REDUNDANT) {
        const at = coding.indexOf(marker);
        if (at < first) first = at;
    }
    let prose = coding.slice(0, first).trim();
    if (prose.length === 0) throw new Error('[fix93] profile.coding has no instruction prose before its placeholders');
    if (prose.includes('$NAME')) {
        if (typeof name !== 'string' || name.length === 0) throw new Error('[fix93] $NAME is in the coding instructions but the bot name is missing');
        prose = prose.replaceAll('$NAME', name);
    }
    for (const marker of REDUNDANT) {
        if (prose.includes(marker)) throw new Error(`[fix93] coding instructions still contain ${marker}`);
    }
    return prose;
}

// Ollama 400: {"error":"request (8243 tokens) exceeds the available context size (8192 tokens), try increasing it"}
export function parseContextOverflow(message) {
    if (typeof message !== 'string' || message.length === 0) return null;
    const match = message.match(/request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/);
    if (!match) return null;
    return { requestTokens: Number(match[1]), contextTokens: Number(match[2]) };
}

// /api/show model_info uses "<architecture>.context_length" (Ollama API: llama.context_length).
export function contextLengthFromModelInfo(modelInfo) {
    if (!modelInfo || typeof modelInfo !== 'object') throw new Error('[fix94] /api/show model_info required');
    const keys = Object.keys(modelInfo).filter((key) => key === 'context_length' || key.endsWith('.context_length'));
    if (keys.length !== 1) {
        throw new Error(`[fix94] /api/show model_info context_length fields: ${keys.length === 0 ? 'none' : keys.join(', ')}`);
    }
    const length = modelInfo[keys[0]];
    if (typeof length !== 'number' || !Number.isInteger(length) || length <= 0) {
        throw new Error(`[fix94] context_length is not a positive integer: ${JSON.stringify(length)}`);
    }
    return length;
}

// The prompt budget is the context the request will actually run in.
// options.num_ctx, when the profile sets it, is that window (the 400 names it).
// Otherwise it is model_info's context_length. num_predict, when set, is the generation
// the profile asked for, so the prompt has to leave that room.
export function resolveContextLength(params, show) {
    const options = params && params.options;
    if (options && Object.hasOwn(options, 'num_ctx')) {
        const configured = options.num_ctx;
        if (typeof configured !== 'number' || !Number.isInteger(configured) || configured <= 0) {
            throw new Error(`[fix94] options.num_ctx must be a positive integer, got ${JSON.stringify(configured)}`);
        }
        return { length: configured, source: 'num_ctx' };
    }
    if (!show) throw new Error('[fix94] model context length is not in options.num_ctx and /api/show was not provided');
    return { length: contextLengthFromModelInfo(show.model_info), source: 'model_info' };
}

export function promptBudget(contextLength, numPredict) {
    if (typeof contextLength !== 'number' || !Number.isInteger(contextLength) || contextLength <= 0) {
        throw new Error(`[fix94] context length required, got ${JSON.stringify(contextLength)}`);
    }
    if (numPredict === undefined) return contextLength;
    if (typeof numPredict !== 'number' || !Number.isInteger(numPredict) || numPredict < 0) {
        throw new Error(`[fix94] num_predict must be a non-negative integer, got ${JSON.stringify(numPredict)}`);
    }
    if (numPredict >= contextLength) {
        throw new Error(`[fix94] num_predict ${numPredict} leaves no prompt room in context ${contextLength}`);
    }
    return contextLength - numPredict;
}

// Without a measured chars-per-token, the text's own length is the count: a token is at
// least one character, so this never under-counts and the cut happens before send.
// A measured rate (Ollama prompt_eval_count, or the 400's reported token count) replaces it.
export function estimateTokens(text, charsPerToken) {
    if (typeof text !== 'string') throw new Error('[fix94] prompt text required');
    if (charsPerToken === undefined) return text.length;
    if (typeof charsPerToken !== 'number' || !(charsPerToken > 0)) {
        throw new Error(`[fix94] chars-per-token must be a positive number, got ${JSON.stringify(charsPerToken)}`);
    }
    return Math.ceil(text.length / charsPerToken);
}

function applyKeep(messages, keepChars) {
    let left = keepChars;
    const kept = [];
    for (const message of messages) {
        if (left <= 0) break;
        if (message.content.length <= left) {
            kept.push({ role: message.role, content: message.content });
            left -= message.content.length;
            continue;
        }
        kept.push({ role: message.role, content: message.content.slice(0, left) });
        left = 0;
    }
    if (kept.length === 0) throw new Error('[fix94] prompt cut removed every message; refusing to send');
    return kept;
}

// Keep the front of the prompt (instruction prose) and drop the expandable tail until the
// token estimate fits the budget. Same split as voyagerCodingInstructions: the prose stays,
// the variable tail is what gets cut. Two measurements, then a loud refusal. No retry send.
export function fitChatToBudget(messages, budget, estimate) {
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('[fix94] messages required');
    if (typeof budget !== 'number' || !Number.isInteger(budget) || budget <= 0) {
        throw new Error(`[fix94] prompt budget must be a positive integer, got ${JSON.stringify(budget)}`);
    }
    if (typeof estimate !== 'function') throw new Error('[fix94] token estimate required');
    const original = messages.map((message) => {
        if (!message || typeof message.content !== 'string') throw new Error('[fix94] chat message content must be a string');
        if (typeof message.role !== 'string' || message.role.length === 0) throw new Error('[fix94] chat message role required');
        return { role: message.role, content: message.content };
    });
    const textOf = (list) => list.map((message) => message.content).join('');
    const tokens = estimate(textOf(original));
    if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens < 0) {
        throw new Error(`[fix94] token estimate must be a non-negative integer, got ${JSON.stringify(tokens)}`);
    }
    if (tokens <= budget) return { messages: original, tokens, cut: false };
    const full = textOf(original);
    if (full.length === 0) throw new Error(`[fix94] prompt is ${tokens} tokens and the context budget is ${budget}; refusing to send`);
    const keepChars = Math.floor(full.length * budget / tokens);
    if (keepChars <= 0) throw new Error(`[fix94] prompt is ${tokens} tokens and the context budget is ${budget}; no prefix fits`);
    let fitted = applyKeep(original, keepChars);
    let fittedTokens = estimate(textOf(fitted));
    if (fittedTokens <= budget) return { messages: fitted, tokens: fittedTokens, cut: true };
    const fittedText = textOf(fitted);
    const keepAgain = Math.floor(fittedText.length * budget / fittedTokens);
    if (keepAgain <= 0 || keepAgain >= fittedText.length) {
        throw new Error(`[fix94] prompt is ${fittedTokens} tokens after cut; context budget is ${budget}; refusing to send`);
    }
    fitted = applyKeep(original, keepAgain);
    fittedTokens = estimate(textOf(fitted));
    if (fittedTokens > budget) {
        throw new Error(`[fix94] prompt is ${fittedTokens} tokens after cut; context budget is ${budget}; refusing to send`);
    }
    return { messages: fitted, tokens: fittedTokens, cut: true };
}
