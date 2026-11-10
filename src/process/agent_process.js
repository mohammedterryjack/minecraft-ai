import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindcraft/mindserver.js';
import { logExitCause, writeProcessLoud } from './exit_log.js';
import { parentExitForChild } from './backend_unavailable.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

// Same directory as logs/mindcraft.log (run-native.sh, overlay/server.js).
const LOGS_DIR = fileURLToPath(new URL('../../logs/', import.meta.url));
export const HEAP_SNAPSHOT_DIR = path.join(LOGS_DIR, 'heap');

// Node options must precede the script. mkdir throws; the child is not spawned without the directory.
export function agentChildArgv(name, port, load_memory, init_message, count_id) {
    mkdirSync(HEAP_SNAPSHOT_DIR, { recursive: true });
    const args = [
        '--heapsnapshot-signal=SIGUSR2',
        `--diagnostic-dir=${HEAP_SNAPSHOT_DIR}`,
        init_agent_path,
        name,
    ];
    args.push('-n', name);
    args.push('-c', count_id);
    if (load_memory)
        args.push('-l', load_memory);
    if (init_message)
        args.push('-m', init_message);
    args.push('-p', port);
    return args;
}

export class AgentProcess {
    constructor(name, port) {
        this.name = name;
        this.port = port;
    }

    start(load_memory=false, init_message=null, count_id=0) {
        this.count_id = count_id;
        this.running = true;

        const args = agentChildArgv(this.name, this.port, load_memory, init_message, count_id);

        const agentProcess = spawn(process.execPath, args, {
            stdio: 'inherit',
            stderr: 'inherit',
        });
        
        agentProcess.on('exit', (code, signal) => {
            this.running = false;
            logoutAgent(this.name);
            // Parent exits with the child's status. Exit 0 (SIGINT) is a successful exit:
            // KeepAlive SuccessfulExit false does not restart it. Exit 75 (backend ready) is the
            // one respawn. A crash stays nonzero.
            const decided = parentExitForChild(code, signal);
            logExitCause(`agent child ${this.name} exited code=${code} signal=${signal}; parent exiting ${decided.code} (${decided.kind})`);
            process.exit(decided.code);
        });
    
        agentProcess.on('error', (err) => {
            writeProcessLoud(`agent child ${this.name} process error: ${err instanceof Error ? err.stack : err}`);
        });

        this.process = agentProcess;
    }

    stop() {
        if (!this.running) return;
        this.process.kill('SIGINT');
    }

    forceRestart() {
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);
            
            const restartTimeout = setTimeout(() => {
                console.warn(`Agent ${this.name} did not stop in time. It might be stuck.`);
            }, 5000); // 5 seconds to exit

            this.process.once('exit', () => {
                 clearTimeout(restartTimeout);
                 console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                 this.start(true, 'Agent process restarted.', this.count_id);
            });
            this.stop(); // sends SIGINT
        } else {
             this.start(true, 'Agent process restarted.', this.count_id);
        }
    }
}