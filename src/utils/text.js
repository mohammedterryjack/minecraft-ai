export function stringifyTurns(turns) {
    let res = '';
    for (let turn of turns) {
        if (turn.role === 'assistant') {
            res += `\nYour output:\n${turn.content}`;
        } else if (turn.role === 'system') {
            res += `\nSystem output: ${turn.content}`;
        } else {
            res += `\nUser input: ${turn.content}`;
        
        }
    }
    return res.trim();
}

export function toSinglePrompt(turns, system=null, stop_seq='***', model_nickname='assistant') {
    let prompt = system ? `${system}${stop_seq}` : '';
    let role = '';
    turns.forEach((message) => {
        role = message.role;
        if (role === 'assistant') role = model_nickname;
        prompt += `${role}: ${message.content}${stop_seq}`;
    });
    if (role !== model_nickname) // if the last message was from the user/system, add a prompt for the model. otherwise, pretend we are extending the model's own message
        prompt += model_nickname + ": ";
    return prompt;
}

function _getWords(text) {
    return String(text ?? "").replace(/[^a-zA-Z ]/g, '').toLowerCase().split(' ');
}

export function wordOverlapScore(text1, text2) {
    const words1 = _getWords(text1);
    const words2 = _getWords(text2);
    const intersection = words1.filter(word => words2.includes(word));
    return intersection.length / (words1.length + words2.length - intersection.length);
}

// fix193: fast path for one query scored against MANY texts (voyager _lexicalReplay: ~900 skills per routing call,
// called once per learned skill by _polyMerge — the quadratic regex/includes cost blocked the event loop for seconds,
// see [loop-stall] live 26 Nov). overlapWithSet(q, t) === wordOverlapScore(text1, t) exactly, including the
// empty-token artifact of _getWords, so scores and rankings are unchanged. makeOverlapTarget precomputes the text2
// side once per skill (voyager caches it per skill object, validated against s.task).
export function makeOverlapQuery(text1) {
    const words1 = _getWords(text1);
    const counts = new Map();
    for (const w of words1) counts.set(w, (counts.get(w) || 0) + 1);
    return { words1, counts };
}
export function makeOverlapTarget(text2) {
    const words2 = _getWords(text2);
    return { set: new Set(words2), len: words2.length };
}
export function overlapWithFields(q, t) {
    let inter = 0;
    for (const [w, c] of q.counts) if (t.set.has(w)) inter += c;
    return inter / (q.words1.length + t.len - inter);
}
export function overlapWithSet(q, text2) {
    return overlapWithFields(q, makeOverlapTarget(text2));
}

// ensures stricter turn order and roles:
// - system messages are treated as user messages and prefixed with SYSTEM:
// - combines repeated messages from users
// - separates repeat assistant messages with filler user messages
export function strictFormat(turns) {
    let prev_role = null;
    let messages = [];
    let filler = {role: 'user', content: '_'};
    for (let msg of turns) {
        if (typeof msg.content === 'string')  {
            msg.content = msg.content.trim();
        }
        if (msg.role === 'system') {
            msg.role = 'user';
            msg.content = 'SYSTEM: ' + msg.content;
        }
        if (msg.role === prev_role && msg.role === 'assistant') {
            // insert empty user message to separate assistant messages
            messages.push(filler);
            messages.push(msg);
        }
        else if (msg.role === prev_role) {
            // combine new message with previous message instead of adding a new one
            messages[messages.length-1].content += '\n' + msg.content;
        }
        else {
            messages.push(msg);
        }
        prev_role = msg.role;
        
    }
    if (messages.length > 0 && messages[0].role !== 'user') {
        messages.unshift(filler); // anthropic requires user message to start
    }
    if (messages.length === 0) {
        messages.push(filler);
    }
    return messages;
}