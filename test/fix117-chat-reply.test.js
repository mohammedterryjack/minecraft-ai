/**
 * fix117 (live icefox2000, 15 Nov 2026, 15:16-15:23 GMT):
 * Players said icefox "does not answer in chat". Server log shows replies DID arrive
 * (15:20:08, 15:20:59, 15:23:14 for p34_l's 15:19:50 message) but:
 *  A. the second reply was command-only ("!setMode(\"night_shelter\", true)"), which in
 *     show_command_syntax="shortened" is spoken as "*used setMode*" — content the player
 *     reads as no answer. The command's own result ("Mode night_shelter is now on.")
 *     only went into history.
 *  B. outgoing chat was never logged in mindcraft.log, so a "no reply" report could not
 *     be told apart from a silent send failure.
 *  C. the default conversing prompt tells the bot to "use commands immediately when
 *     requested" with no priority for answering the actual question, and the death
 *     system messages in history pushed the small model to answer chat with !setMode.
 *  D. profiles/mo_bot.json overrode every protective mode to false (repo defaults are
 *     self_preservation/unstuck/self_defense true, profiles/defaults/_default.json:17-21);
 *     16 deaths today (15 by command-summoned "Black/Red Figure" mannequins, 5 phantoms)
 *     with the bot standing still.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';

const agent_src = readFileSync('src/agent/agent.js', 'utf8');
const mo_profile = JSON.parse(readFileSync('profiles/mo_bot.json', 'utf8'));
const default_profile = JSON.parse(readFileSync('profiles/defaults/_default.json', 'utf8'));

describe('fix117 A: a command-only conversation reply gives the player the command result', () => {
    it('the loop tracks command-only replies and routes the executed result', () => {
        assert.match(agent_src, /let command_only_reply = false;/);
        assert.match(agent_src, /command_only_reply = pre_message\.length === 0;/);
        assert.match(agent_src, /if \(command_only_reply && execute_res\)\s*\n\s*this\.routeResponse\(source, String\(execute_res\)\);/);
    });
    it('the flag is reset every loop iteration (a text reply never inherits an earlier command-only flag)', () => {
        // declaration must be inside the response loop: it appears after promptConvo
        // (per iteration), not once per connection
        assert.match(agent_src, /let res = await this\.prompter\.promptConvo\(history\);[\s\S]*?let command_name = containsCommand\(res\);[\s\S]*?let command_only_reply = false;/);
    });
});

describe('fix117 B: every outgoing in-game chat line is logged', () => {
    it('openChat logs the message before sending', () => {
        assert.match(agent_src, /console\.log\(`\$\{this\.name\} says in-game: \$\{message\}`\);/);
        const openChat = agent_src.slice(agent_src.indexOf('async openChat('));
        const logIdx = openChat.indexOf('says in-game');
        const sendIdx = openChat.indexOf('this.bot.chat(message)');
        assert.ok(logIdx > -1 && sendIdx > -1 && logIdx < sendIdx,
            'the log line must come before bot.chat so a failed send still leaves the attempt logged');
    });
});

describe('fix117 C: the conversing prompt makes answering the question the first job', () => {
    it('tells the model to answer in plain text and only then use commands', () => {
        assert.match(default_profile.conversing,
            /answer in plain chat text first; use a !command only when the player asked you to do something/);
    });
    it('explicitly bans reactive !setMode', () => {
        assert.match(default_profile.conversing, /never issue !setMode for an event you were not asked about/);
    });
});

describe('fix117 D: protective modes are on in mo_bot.json', () => {
    for (const mode of ['self_preservation', 'unstuck', 'self_defense', 'night_shelter']) {
        it(`${mode} is enabled`, () => {
            assert.strictEqual(mo_profile.modes[mode], true);
        });
    }
    it('modes the player did not ask for stay as configured (no drive-by changes)', () => {
        for (const mode of ['cowardice', 'hunting', 'cheat'])
            assert.strictEqual(mo_profile.modes[mode], false);
    });
});
