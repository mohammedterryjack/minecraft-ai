/**
 * Worker: run ESLint on a single source string off the main thread.
 */
import { ESLint } from 'eslint';
import { parentPort } from 'node:worker_threads';

parentPort.on('message', async (code) => {
    if (typeof code !== 'string') {
        parentPort.postMessage({ error: 'eslint_lint_worker: expected string' });
        return;
    }
    const eslint = new ESLint();
    const results = await eslint.lintText(code);
    parentPort.postMessage({ results });
});
