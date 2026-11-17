// fix136: protocols >=1.21.2 (e.g. 26.1) accept one position packet per client tick and
// reset the counter on tick_end; mineflayer never sends tick_end
// (PrismarineJS/mineflayer#4189, ViaVersion/ViaBackwards#1362) -> second move in a tick
// gets multiplayer.disconnect.invalid_player_movement. We append tick_end after every
// position-carrying packet. Guard (fix108 incident): on protocols without packet_tick_end
// (e.g. 1.20.4) writing an unmapped name sends id 0x00 = Accept Teleportation and crashes
// ViaBackwards — so the sender must be gated on the protocol data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installTickEndAfterMove, protocolHasTickEnd } from '../src/utils/tick_end.js';
import minecraftData from 'minecraft-data';

function fakeClient() {
    const writes = [];
    return { writes, write(name, data) { writes.push([name, data]); } };
}

test('protocolHasTickEnd matches minecraft-data', () => {
    assert.equal(protocolHasTickEnd(minecraftData('1.20.4').protocol), false);
    assert.equal(protocolHasTickEnd(minecraftData('26.1').protocol), true);
    assert.equal(protocolHasTickEnd(undefined), false);
});

test('tick_end follows position, position_look and teleport_confirm when protocol has it', () => {
    const c = fakeClient();
    assert.equal(installTickEndAfterMove(c, () => true), true);
    c.write('position', { x: 1, y: 2, z: 3, onGround: true });
    c.write('look', { yaw: 0.5, pitch: 0 });
    c.write('position_look', { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, onGround: true });
    c.write('teleport_confirm', { teleportId: 7 });
    assert.deepEqual(c.writes.map(w => w[0]),
        ['position', 'tick_end', 'look', 'position_look', 'tick_end', 'teleport_confirm', 'tick_end']);
});

test('no tick_end is ever emitted when the protocol lacks it (fix108 guard)', () => {
    const c = fakeClient();
    assert.equal(installTickEndAfterMove(c, () => false), true);
    c.write('position', { x: 1, y: 2, z: 3, onGround: true });
    c.write('teleport_confirm', { teleportId: 1 });
    assert.deepEqual(c.writes.map(w => w[0]), ['position', 'teleport_confirm']);
});

test('double install is a no-op', () => {
    const c = fakeClient();
    assert.equal(installTickEndAfterMove(c, () => true), true);
    assert.equal(installTickEndAfterMove(c, () => true), false);
    c.write('position', {});
    assert.deepEqual(c.writes.map(w => w[0]), ['position', 'tick_end']);
});
