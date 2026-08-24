/**
 * Bridge between the plugin's gateway primitives and @discordjs/voice's
 * expected DiscordGatewayAdapter interface.
 *
 * @discordjs/voice does not ship a gateway — every consumer provides an adapter
 * that knows how to (a) send op-4 voice-state updates and (b) deliver
 * VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE events. `gateway.ts` exposes exactly
 * those two primitives through its `voice` handle, so voice rides the plugin's
 * single existing gateway socket: no second Discord connection is opened, and
 * the adapter never sees the socket or the reconnect state behind the handle.
 *
 * `sendPayload` returns false when there is no OPEN socket (mid-reconnect, or
 * after shutdown). That boolean is part of the @discordjs/voice contract — it
 * treats a false return as "not delivered" and retries the signalling itself.
 */

import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";

import type { GatewayVoiceHandle } from "../gateway.js";

// @discordjs/voice declares its dispatch-data types internally (via discord-api-types)
// but doesn't re-export them. We use Parameters<typeof methods.onVoice*Update>[0]
// to read them off the function signatures we pass to — this keeps the cast
// honest without importing an internal type.
export function createPluginDiscordAdapter(
  gatewayVoice: GatewayVoiceHandle,
): DiscordGatewayAdapterCreator {
  return (methods) => {
    type StateData = Parameters<typeof methods.onVoiceStateUpdate>[0];
    type ServerData = Parameters<typeof methods.onVoiceServerUpdate>[0];

    const unsubscribes: Array<() => void> = [
      gatewayVoice.onVoiceStateUpdate((event) => {
        methods.onVoiceStateUpdate(event as unknown as StateData);
      }),
      gatewayVoice.onVoiceServerUpdate((event) => {
        methods.onVoiceServerUpdate(event as unknown as ServerData);
      }),
    ];

    return {
      sendPayload(payload) {
        return gatewayVoice.sendPayload(payload);
      },
      destroy() {
        // Detach this connection's handlers from the gateway. Without this a
        // destroyed voice connection would keep receiving dispatch for the
        // lifetime of the plugin.
        while (unsubscribes.length > 0) {
          unsubscribes.pop()!();
        }
      },
    };
  };
}
