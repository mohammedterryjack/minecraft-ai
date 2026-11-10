import { workOf } from './call_durations.js';

// fix97: the one Ollama token count this repo has for a code-retry prompt.
// Composer call #78, kind compose-retry, fix96 1c2f9c0. Task: Collect 1 stripped_birch_wood,
// a subgoal of Craft 4 birch_planks.
// Prompt log: [prompt] kind=code-retry total=181705 chars: system=3721 skills=2192 prelude=3760
// state=390 history=785 retry=170464 framing=393
// Ollama then counted that request at 58984 tokens against num_ctx 8192 (the user message was 174224
// chars; the system side of the same count is 7481, which is totalChars - userChars). NEVER_CUT_PROMPT
// threw. There is no offline tokenizer: the live bound learns chars per token only from Ollama's
// prompt_eval_count (call_durations.workOf, then recordCall, then callBound). This checkout has no
// Ollama binary and no tokenizer package, so that reply cannot be reproduced. This object is that reply.
export const CODE_RETRY_78 = Object.freeze({
    commit: '1c2f9c0',
    call: 78,
    kind: 'code-retry',
    task: 'Collect 1 stripped_birch_wood',
    totalChars: 181705,
    systemChars: 3721,
    skillsChars: 2192,
    preludeChars: 3760,
    stateChars: 390,
    historyChars: 785,
    retryChars: 170464,
    framingChars: 393,
    userChars: 174224,
    systemMessageChars: 7481,
    promptTokens: 58984,
    contextTokens: 8192,
});

// workOf requires prompt_eval_duration, eval_count, and eval_duration on a chat reply. The overflow
// threw before those durations were a successful sample. They are present so the reply shape is the
// one the live bound reads; the token estimate uses prompt_eval_count and the char count only.
// call_durations converts durations from nanoseconds (ns / 1e6).
const REPLY_DURATION_NS = 1e6;
const REPLY_EVAL_COUNT = 1;

export function observedChatWork() {
    return workOf('/api/chat', {
        prompt_eval_count: CODE_RETRY_78.promptTokens,
        prompt_eval_duration: REPLY_DURATION_NS,
        eval_count: REPLY_EVAL_COUNT,
        eval_duration: REPLY_DURATION_NS,
    });
}
