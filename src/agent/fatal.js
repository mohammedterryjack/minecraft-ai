// fix59: the agent can no longer act -> fail loud and exit 1, the same path as #44's onDisconnect (agent.js):
// verbatim error to console and the agent log (MindServer), then process.exit(1). agent_process.js makes the parent
// exit on a non-zero child exit, so launchd restarts com.mo.icefox. No catch-and-continue.
import { inspect } from 'node:util';
import { log } from './connection_handler.js';
import { logExitCause } from '../process/exit_log.js';

export function fatalExit(agentName, where, err) {
    const raw = err instanceof Error ? err.stack : inspect(err, { depth: 6, maxArrayLength: 50, breakLength: 120 });
    const msg = `[fatal] ${where}; agent cannot act, exiting 1: ${raw}`;
    logExitCause(msg);
    console.error(msg);
    log(agentName, msg);
    process.exit(1);
}

// one update() at a time, even if it takes longer than the interval. Never resolves; rejects with update()'s error.
export async function runUpdateLoop(update, interval) {
    let last = Date.now();
    while (true) {
        const start = Date.now();
        await update(start - last);
        const remaining = interval - (Date.now() - start);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        last = start;
    }
}
