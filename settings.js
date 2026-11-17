const settings = {
    // fix135 NOTE (unresolved, investigation 16 Nov 2026 23:50 GMT): the server is 26.3
    // (protocol 775) and this file said 1.20.4 — every packet is downgraded ~40 versions by
    // ViaProxy/ViaVersion, and that translation is what loses block updates: server world
    // files hold furnaces/cobble the client still reads as air ("Server refused to place
    // furnace ... the block is still air"), Paper spams "Player icefox2000 standing on air"
    // (256x), and navigation stalls on ghost geometry. Tried minecraft_version "26.1"
    // (mineflayer 4.39.0 supported list, same wire protocol 775): login succeeds then the
    // server kicks "multiplayer.disconnect.invalid_player_movement" 18x in 3 minutes —
    // ViaProxy (target-version 26.2) still translates 26.1->26.3 and mangles position
    // packets. Reverted to 1.20.4 (works with the known desync tax). Real fix needs Mo:
    // ViaProxy target-version 26.3 (viaproxy.yml is Mo's process), then retest 26.1 here.
    "minecraft_version": "1.20.4", // or specific version like "1.21.6"
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
