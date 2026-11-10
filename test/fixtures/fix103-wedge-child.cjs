// A throw inside a packet listener, swallowed the way Voyager used to swallow uncaughtException,
// leaves minecraft-protocol's inbound pipeline (splitter -> deserializer) wedged.
// The writes are scheduled off the caller's stack, same as the live socket, so the throw is an
// uncaughtException inside FullPacketParser._transform's push and cb() never runs.
const { createSerializer, createDeserializer } = require('minecraft-protocol/src/transforms/serializer');
const framing = require('minecraft-protocol/src/transforms/framing');
const { EventEmitter } = require('events');

const version = '1.20.4';
const ser = createSerializer({ state: 'play', isServer: true, version });
const framer = framing.createFramer();
const splitter = framing.createSplitter();
const des = createDeserializer({ state: 'play', isServer: false, version });
ser.pipe(framer).pipe(splitter).pipe(des);
const client = new EventEmitter();
des.on('data', (packet) => client.emit(packet.data.name, packet.data.params));

let swallowed = 0;
process.on('uncaughtException', (err) => {
    swallowed += 1;
    process.stderr.write(`swallowed uncaught #${swallowed}: ${err.message}\n`);
});

const got = [];
client.on('keep_alive', (packet) => got.push(`keep_alive ${packet.keepAliveId}`));
client.on('block_change', () => {
    got.push('block_change');
    throw new Error('nearby blocks: chunk 6,6 is loaded in the view and is neither indexed nor pending.');
});

ser.write({ name: 'keep_alive', params: { keepAliveId: 1n } });
setTimeout(() => ser.write({ name: 'block_change', params: { location: { x: 99, y: 70, z: 99 }, type: 1 } }), 20);
for (let i = 2; i <= 4; i++) setTimeout(() => ser.write({ name: 'keep_alive', params: { keepAliveId: BigInt(i) } }), 40 * i);
setTimeout(() => {
    const ws = des._writableState;
    const ss = splitter._writableState;
    const keepAlives = got.filter((line) => line.startsWith('keep_alive'));
    const wedged = swallowed === 1 && keepAlives.length === 1 && ws.writing === true && ss.writing === true;
    process.stdout.write(`${JSON.stringify({
        delivered: got,
        swallowed,
        deserializerWriting: ws.writing,
        splitterWriting: ss.writing,
        wedged,
    })}\n`);
    process.exit(wedged ? 0 : 1);
}, 400);
