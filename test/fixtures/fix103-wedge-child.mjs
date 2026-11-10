// The real minecraft-protocol pipeline, a block_change listener that throws, and the process
// guard installed the way voyager.js installs it, with agent.fatal = fatalExit (fatal.js).
// Old code: _onProcessError records the step and stays alive, so the deadline prints the wedge and exits 0.
// Fixed code: fatalExit exits 1 inside the throw, before the next keep_alive.
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.argv[2];
process.chdir(root);
const require = createRequire(path.join(root, 'package.json'));
const { createSerializer, createDeserializer } = require('minecraft-protocol/src/transforms/serializer');
const framing = require('minecraft-protocol/src/transforms/framing');
const { EventEmitter } = require('node:events');
const { Voyager } = await import(path.join(root, 'src/agent/voyager.js'));
const { fatalExit } = await import(path.join(root, 'src/agent/fatal.js'));

const v = Object.create(Voyager.prototype);
v.running = true;
v.currentTask = 'reach iron_ore';
v.progress = { failed: [] };
v._saveProgress = () => process.stdout.write('SAVED\n');
v.agent = {
    name: 'probe',
    fatal: (where, err) => fatalExit('probe', where, err),
    requestInterrupt: () => {},
    actions: { stop: () => Promise.resolve() },
};
const onErr = (kind) => (err) => v._onProcessError(kind, err);
process.on('uncaughtException', onErr('UNCAUGHT EXCEPTION'));
process.on('unhandledRejection', onErr('UNHANDLED REJECTION'));

const version = '1.20.4';
const ser = createSerializer({ state: 'play', isServer: true, version });
const splitter = framing.createSplitter();
const des = createDeserializer({ state: 'play', isServer: false, version });
ser.pipe(framing.createFramer()).pipe(splitter).pipe(des);
const client = new EventEmitter();
des.on('data', (packet) => client.emit(packet.data.name, packet.data.params));

const got = [];
client.on('keep_alive', (packet) => got.push(`keep_alive ${packet.keepAliveId}`));
client.on('block_change', () => {
    got.push('block_change');
    process.stdout.write(`${JSON.stringify({ delivered: got.slice(), failed: v.progress.failed.slice() })}\n`);
    throw new Error('nearby blocks: chunk 6,6 is loaded in the view and is neither indexed nor pending.');
});

ser.write({ name: 'keep_alive', params: { keepAliveId: 1n } });
setTimeout(() => ser.write({ name: 'block_change', params: { location: { x: 99, y: 70, z: 99 }, type: 1 } }), 20);
for (let i = 2; i <= 4; i++) setTimeout(() => ser.write({ name: 'keep_alive', params: { keepAliveId: BigInt(i) } }), 40 * i);
setTimeout(() => {
    const keepAlives = got.filter((line) => line.startsWith('keep_alive'));
    const wedged = keepAlives.length === 1 && des._writableState.writing === true && splitter._writableState.writing === true;
    process.stdout.write(`${JSON.stringify({
        alive: true,
        delivered: got,
        failed: v.progress.failed,
        deserializerWriting: des._writableState.writing,
        splitterWriting: splitter._writableState.writing,
        wedged,
    })}\n`);
    process.exit(wedged ? 0 : 1);
}, 400);
