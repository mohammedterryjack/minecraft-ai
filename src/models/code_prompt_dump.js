import { writeFileSync } from 'fs';

// promptCoding and Voyager._ask both write the code prompt here, before the request is sent.
// _ask calls the code model directly, so a compose-retry that throws never reached promptCoding's dump.
export const CODE_PROMPT_DUMP = '/tmp/icefox_code_prompt.txt';

export function writeCodePromptDump(system, user) {
    if (typeof system !== 'string') throw new Error('[code-prompt] system prompt must be text');
    const userText = user === undefined ? '' : user;
    if (typeof userText !== 'string') throw new Error('[code-prompt] user prompt must be text');
    writeFileSync(CODE_PROMPT_DUMP, `SYSTEM:\n${system}\n\nUSER:\n${userText}\n`);
}
