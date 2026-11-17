const settings = {
    // fix135 (17 Nov 2026): Mo set ViaProxy target-version to 26.3 (proxy restarted 09:07 GMT).
    // The bundled minecraft-data 3.119.0 ships pc data for 26.1 only (no 26.3 dir), and
    // voyager's fix52 registry check LOUD FAILs on a version without data — so connect as
    // 26.1 (protocol 775). ViaVersion now translates 775->776->777 along its own supported
    // step path instead of the ~40-version 1.20.4->26.3 jump that lost block updates
    // ("Server refused to place ... the block is still air", Paper "standing on air" 256x,
    // ghost geometry — region files proved server-side placements the client read as air).
    // Earlier 26.1 attempt kicked invalid_player_movement only because viaproxy.yml still
    // had target-version 26.2 (wrong target = broken movement translation).
    // Upgrade path to true pass-through: bump minecraft-data to a release with pc/26.3.
    // fix136 (17 Nov 2026): native 26.1 unblocked. The invalid_player_movement kick had a
    // documented root cause: since 1.21.2 vanilla allows ONE position packet per client tick,
    // reset by tick_end; mineflayer never sends tick_end (PrismarineJS/mineflayer#4189;
    // ViaVersion/ViaBackwards#1362 documents exactly our 26.3-server symptom and notes old
    // clients only survive because ViaBackwards synthesizes tick_end for them). src/utils/
    // tick_end.js now appends tick_end after every position packet, gated on the protocol
    // defining packet_tick_end (fix108 guard: never on 1.20.4). 26.1 (protocol 775) through
    // ViaProxy target-version 26.3 pays only the 775->777 same-family block remap instead of
    // the lossy 1.20.4 cross-boundary (1.20.5 blockstate-flattening) remap that produced the
    // ghost-block placements. Upgrade path unchanged: when minecraft-data ships pc/26.3, set
    // "26.3" for pass-through.
    "minecraft_version": "26.1",
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 25568, // set to -1 to automatically scan for open ports
    // fix94: vanilla backend log directory. Confirmed from the iMac launcher
    // ~/bin/start-minecraftserver-screen.sh, which cds to /Users/mohammedterry-jack/MinecraftServer
    // (com.mo.minecraftserver ProgramArguments). The bot lives under ~/MinecraftBot; the server does not.
    // No code default: a missing backend_log_dir throws.
    "backend_log_dir": "/Users/mohammedterry-jack/MinecraftServer/logs",
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": false, // opens UI in browser on startup
    
    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "profiles": [
        "./profiles/mo_bot.json",
        // "./profiles/gpt.json",
        // "./profiles/claude.json",
        // "./profiles/gemini.json",
        // "./profiles/llama.json",
        // "./profiles/qwen.json",
        // "./profiles/grok.json",
        // "./profiles/mistral.json",
        // "./profiles/deepseek.json",
        // "./profiles/mercury.json",
        // "./profiles/andy-4.json", // Supports up to 75 messages!

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    "load_memory": true, // load memory from previous session
    "init_message": "Respond with hello world and your name", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": true, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": true, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": false, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!startConversation", "!endConversation", "!restart", "!clearChat", "!stfu", "!placeHere", "!goToRememberedPlace"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 30, // max number of messages to keep in context
    "num_examples": 2, // number of examples to give to the model
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    
    // fix47: prompt efficiency settings
    "skill_topk": 8, // number of relevant skills to include in code prompts (embedding search)
    "api_topk": 15, // number of relevant built-in API functions to include (embedding search, rest available as core)
    "show_command_syntax": "shortened", // "full", "shortened", or "none"
    "narrate_behavior": false, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.
  
    "log_all_prompts": false, // log ALL prompts to file
};

export default settings;
