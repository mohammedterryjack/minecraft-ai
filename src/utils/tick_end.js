// fix136: send the serverbound `tick_end` packet after every position-carrying packet
// on protocols that define it (1.21.2+).
//
// Root cause of the invalid_player_movement kick loop when connecting natively at 26.1:
// since 1.21.2, vanilla ServerGamePacketListenerImpl.handleMovePlayer (and
// handleAcceptTeleportPacket) accept at most ONE position packet per client tick; the
// counter resets on the clientbound tick-end. A vanilla client sends exactly one tick_end
// per client tick alongside its single move packet. mineflayer never sends tick_end at
// all (PrismarineJS/mineflayer#4189), so its second move packet inside a tick gets
// kicked: "multiplayer.disconnect.invalid_player_movement". The ViaVersion team
// documented exactly this for our setup in ViaVersion/ViaBackwards#1362: real <1.21.2
// clients survive only because ViaBackwards synthesizes tick_end for them on the server
// side; a client speaking >=1.21.2 (mineflayer at 26.1) is expected to send it itself
// and mineflayer does not.
//
// fix108 incident guard: on protocols BELOW 1.21.2 packet_tick_end does not exist in
// minecraft-data (verified: pc/1.20.4/protocol.json has no packet_tick_end). Writing an
// unmapped packet name makes protodef emit id 0x00, which on 1.20.3/1.20.4 is Accept
// Teleportation (VarInt teleportId); ViaBackwards' EntityPacketRewriter26_3 then crashes
// IndexOutOfBoundsException on the empty body and kills the connection. So the sender is
// gated on the protocol actually defining packet_tick_end — on 1.20.4 it is a no-op.
//
// Placement: appended right after each move packet (position, position_look) and after
// teleport_confirm (the 26.x accept-teleport handler validates coordinates too, see
// ViaBackwards#1362). Vanilla rhythm is one tick_end per tick; mineflayer sends at most
// one move packet per physics interval, so this matches the vanilla rate.

const MOVE_PACKETS = new Set(['position', 'position_look', 'teleport_confirm']);

/** True when the protocol data defines the serverbound tick_end packet (1.21.2+). */
export function protocolHasTickEnd(protocolData) {
    return !!(protocolData && protocolData.play && protocolData.play.toServer &&
        protocolData.play.toServer.types && protocolData.play.toServer.types.packet_tick_end);
}

/**
 * Wrap client.write so every position-carrying packet is followed by tick_end.
 * @param {object} client mineflayer/NMP client (has .write)
 * @param {() => boolean} hasTickEndProvider called per write; true when the negotiated
 *   protocol defines tick_end. A function because with version:"auto" the protocol is
 *   only known after negotiation.
 * @returns {boolean} true when the wrapper was installed
 */
export function installTickEndAfterMove(client, hasTickEndProvider) {
    if (!client || typeof client.write !== 'function') return false;
    if (client.__mcTickEndInstalled) return false;
    client.__mcTickEndInstalled = true;
    const orig = client.write.bind(client);
    client.write = function (name, data) {
        const r = orig(name, data);
        if (MOVE_PACKETS.has(name) && hasTickEndProvider()) orig('tick_end', {});
        return r;
    };
    return true;
}
