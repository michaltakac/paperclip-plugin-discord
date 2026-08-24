import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// ---------------------------------------------------------------------------
// VoiceClient lifecycle and utterance pipeline — review findings F2, F3, F5.
//
// F2: joining is driven by the gateway's READY/RESUMED boundary. `start()` must
//     not join, because an op-4 sent before the socket has identified is not
//     deliverable and @discordjs/voice does not retry one it could not send.
// F3: a receive-stream error must not become an uncaught exception. Node does
//     not forward a source's `error` through `pipe()`, and @discordjs/voice
//     destroys the receive stream with an error when RTP parsing or decryption
//     fails — so an unlistened source error takes the whole worker down, text
//     routing included.
// F5: a start that fails after the connection was constructed must destroy it
//     and unsubscribe its gateway adapter, and must say so through health.
// ---------------------------------------------------------------------------

const { voiceState } = vi.hoisted(() => ({
  voiceState: {
    connections: [] as FakeConnection[],
    /** Whether entersState resolves; false models a readiness timeout. */
    becomesReady: true,
    /** Whether joinVoiceChannel itself throws (no adapter, bad ids). */
    joinThrows: false,
  },
}));

type FakeConnection = {
  status: string;
  destroyed: boolean;
  adapterDestroyed: boolean;
  state: { status: string };
  receiver: {
    speaking: EventEmitter;
    subscribe: (userId: string) => PassThrough;
    streams: PassThrough[];
  };
  destroy: () => void;
};

vi.mock("@discordjs/voice", () => {
  const VoiceConnectionStatus = {
    Signalling: "signalling",
    Connecting: "connecting",
    Ready: "ready",
    Disconnected: "disconnected",
    Destroyed: "destroyed",
  };
  return {
    VoiceConnectionStatus,
    EndBehaviorType: { AfterSilence: 1, Manual: 0 },
    joinVoiceChannel: (opts: any) => {
      if (voiceState.joinThrows) throw new Error("join failed");
      const streams: PassThrough[] = [];
      // Mirrors the real adapter contract: destroying the connection destroys
      // the adapter, which is what releases the gateway subscriptions.
      const adapter = opts.adapterCreator({
        onVoiceStateUpdate: () => {},
        onVoiceServerUpdate: () => {},
        destroy: () => {},
      });
      const connection: FakeConnection = {
        status: VoiceConnectionStatus.Signalling,
        destroyed: false,
        adapterDestroyed: false,
        state: { status: VoiceConnectionStatus.Signalling },
        receiver: {
          speaking: new EventEmitter(),
          streams,
          subscribe: () => {
            const stream = new PassThrough();
            streams.push(stream);
            return stream;
          },
        },
        destroy() {
          if (this.destroyed) throw new Error("Cannot destroy VoiceConnection - it has already been destroyed");
          this.destroyed = true;
          this.state.status = VoiceConnectionStatus.Destroyed;
          adapter.destroy?.();
          connection.adapterDestroyed = true;
        },
      };
      voiceState.connections.push(connection);
      return connection;
    },
    entersState: async (connection: FakeConnection) => {
      if (!voiceState.becomesReady) throw new Error("readiness timed out");
      connection.state.status = "ready";
      return connection;
    },
  };
});

vi.mock("prism-media", () => ({
  default: {
    opus: {
      // A PassThrough stands in for the decoder: real enough to pipe into, and
      // it lets a test emit the failures a real decoder would.
      Decoder: class extends PassThrough {
        constructor(_opts: unknown) {
          super();
        }
      },
    },
  },
}));

import { VoiceClient } from "../src/voice/client.js";

function buildCtx() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as any;
}

/** A gateway readiness hook a test drives by hand. */
function readyHook() {
  const handlers = new Set<() => void>();
  return {
    subscribe: (handler: () => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    fire: () => {
      for (const handler of [...handlers]) handler();
    },
    get count() {
      return handlers.size;
    },
  };
}

function buildClient(overrides: Record<string, unknown> = {}) {
  const ctx = buildCtx();
  const hook = readyHook();
  const stt = { transcribeUtterance: vi.fn().mockResolvedValue("hello there") };
  const relay = { postTranscript: vi.fn().mockResolvedValue(undefined) };
  const ingestUtterance = vi.fn().mockResolvedValue(undefined);
  const onAvailabilityChange = vi.fn();
  const adapterDestroy = vi.fn();

  const client = new VoiceClient(
    ctx,
    {
      guildId: "guild-1",
      voiceChannelId: "chan-1",
      textChannelWebhookUrl: "https://discord.test/api/webhooks/1/secret-token",
      deepgramApiKey: "dg-key",
      voiceAdapterCreator: () => ({
        sendPayload: () => true,
        destroy: adapterDestroy,
      }),
      onGatewayReady: hook.subscribe,
      ingestUtterance,
      onAvailabilityChange,
      ...overrides,
    } as any,
    stt as any,
    relay as any,
  );

  return { client, ctx, hook, stt, relay, ingestUtterance, onAvailabilityChange, adapterDestroy };
}

/** One decoded utterance is 0.5 s of PCM — comfortably over the 0.2 s floor. */
const HALF_SECOND_PCM = Buffer.alloc(48_000);

beforeEach(() => {
  voiceState.connections.length = 0;
  voiceState.becomesReady = true;
  voiceState.joinThrows = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("VoiceClient — joining is driven by gateway readiness (F2)", () => {
  it("does not join when start() is called", async () => {
    const { client, hook, onAvailabilityChange } = buildClient();

    await client.start();

    expect(voiceState.connections).toHaveLength(0);
    expect(hook.count).toBe(1);
    expect(onAvailabilityChange).toHaveBeenCalledWith(
      false,
      "waiting for the Discord gateway to be ready",
    );
    client.stop();
  });

  it("joins on the readiness boundary and reports voice available", async () => {
    const { client, hook, onAvailabilityChange } = buildClient();
    await client.start();

    hook.fire();
    await vi.waitFor(() => expect(voiceState.connections).toHaveLength(1));

    expect(onAvailabilityChange).toHaveBeenLastCalledWith(true, undefined);
    client.stop();
  });

  it("leaves a healthy connection alone on a later boundary", async () => {
    const { client, hook } = buildClient();
    await client.start();

    hook.fire();
    await vi.waitFor(() => expect(voiceState.connections).toHaveLength(1));

    hook.fire(); // a RESUMED: the voice connection survived the gateway blip
    await vi.waitFor(() => expect(voiceState.connections).toHaveLength(1));
    client.stop();
  });

  it("rejoins on the next boundary after a failed join", async () => {
    // This is the shape of the bug: the first op-4 is refused, @discordjs/voice
    // gives up, and nothing ever tries again.
    voiceState.becomesReady = false;
    const { client, hook } = buildClient();
    await client.start();

    hook.fire();
    await vi.waitFor(() => expect(voiceState.connections).toHaveLength(1));
    expect(voiceState.connections[0].destroyed).toBe(true);

    voiceState.becomesReady = true;
    hook.fire();
    await vi.waitFor(() => expect(voiceState.connections).toHaveLength(2));
    expect(voiceState.connections[1].destroyed).toBe(false);
    client.stop();
  });

  it("ignores readiness boundaries after stop()", async () => {
    const { client, hook } = buildClient();
    await client.start();
    client.stop();

    hook.fire();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(voiceState.connections).toHaveLength(0);
  });
});

describe("VoiceClient — a failed start leaks nothing and shows in health (F5)", () => {
  it("destroys the connection and unsubscribes the adapter when readiness times out", async () => {
    voiceState.becomesReady = false;
    const { client, hook, onAvailabilityChange } = buildClient();
    await client.start();

    hook.fire();
    await vi.waitFor(() => expect(voiceState.connections).toHaveLength(1));

    expect(voiceState.connections[0].destroyed).toBe(true);
    expect(voiceState.connections[0].adapterDestroyed).toBe(true);
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(
      false,
      "the voice connection did not become ready",
    );
    client.stop();
  });

  it("reports a join that throws without leaving a connection behind", async () => {
    voiceState.joinThrows = true;
    const { client, hook, onAvailabilityChange } = buildClient();
    await client.start();

    hook.fire();
    await vi.waitFor(() =>
      expect(onAvailabilityChange).toHaveBeenLastCalledWith(
        false,
        "the voice channel could not be joined",
      ),
    );
    expect(voiceState.connections).toHaveLength(0);
    client.stop();
  });

  it("never puts the webhook URL or the API key in an availability reason", async () => {
    voiceState.becomesReady = false;
    const { client, hook, onAvailabilityChange } = buildClient();
    await client.start();
    hook.fire();
    await vi.waitFor(() => expect(voiceState.connections).toHaveLength(1));

    const said = JSON.stringify(onAvailabilityChange.mock.calls);
    expect(said).not.toContain("secret-token");
    expect(said).not.toContain("dg-key");
    client.stop();
  });

  it("stop() is idempotent and releases the readiness subscription", async () => {
    const { client, hook } = buildClient();
    await client.start();
    hook.fire();
    await vi.waitFor(() => expect(voiceState.connections).toHaveLength(1));

    client.stop();
    expect(() => client.stop()).not.toThrow();
    expect(hook.count).toBe(0);
    expect(voiceState.connections[0].adapterDestroyed).toBe(true);
  });
});

describe("VoiceClient — a receive-stream failure cannot kill the worker (F3)", () => {
  async function joinedClient() {
    const built = buildClient();
    await built.client.start();
    built.hook.fire();
    await vi.waitFor(() => expect(voiceState.connections).toHaveLength(1));
    return { ...built, connection: voiceState.connections[0] };
  }

  it("survives an error destroying the receive stream, and transcribes nothing", async () => {
    const { client, connection, stt, relay, ingestUtterance, ctx } = await joinedClient();

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      connection.receiver.speaking.emit("start", "user-1");
      await vi.waitFor(() => expect(connection.receiver.streams).toHaveLength(1));

      // Exactly what @discordjs/voice does when RTP parsing or decryption fails.
      connection.receiver.streams[0].destroy(new Error("voice packet decrypt failed"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(uncaught).toHaveLength(0);
      expect(stt.transcribeUtterance).not.toHaveBeenCalled();
      expect(relay.postTranscript).not.toHaveBeenCalled();
      expect(ingestUtterance).not.toHaveBeenCalled();
      expect(ctx.logger.error).toHaveBeenCalledWith(
        "voice: utterance dropped",
        expect.objectContaining({ stage: "receive", userId: "user-1" }),
      );
    } finally {
      process.off("uncaughtException", onUncaught);
      client.stop();
    }
  });

  it("survives a decoder error the same way", async () => {
    const { client, connection, stt, ctx } = await joinedClient();

    connection.receiver.speaking.emit("start", "user-1");
    await vi.waitFor(() => expect(connection.receiver.streams).toHaveLength(1));

    const source = connection.receiver.streams[0];
    source.write(Buffer.alloc(8));
    // The decoder is downstream of the pipe; failing it must settle the same path.
    await new Promise((resolve) => setTimeout(resolve, 5));
    source.destroy(new Error("Could not decode opus frame"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stt.transcribeUtterance).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalled();
    client.stop();
  });

  it("still delivers a clean utterance to ingress and then to the channel", async () => {
    const { client, connection, stt, relay, ingestUtterance } = await joinedClient();

    connection.receiver.speaking.emit("start", "user-1");
    await vi.waitFor(() => expect(connection.receiver.streams).toHaveLength(1));

    connection.receiver.streams[0].end(HALF_SECOND_PCM);
    await vi.waitFor(() => expect(relay.postTranscript).toHaveBeenCalled());

    expect(stt.transcribeUtterance).toHaveBeenCalledTimes(1);
    expect(ingestUtterance).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        text: "hello there",
        threadKey: expect.stringMatching(/^voice:guild-1:chan-1:/),
      }),
    );
    client.stop();
  });

  it("drops an utterance too short to be speech without calling STT", async () => {
    const { client, connection, stt, ingestUtterance } = await joinedClient();

    connection.receiver.speaking.emit("start", "user-1");
    await vi.waitFor(() => expect(connection.receiver.streams).toHaveLength(1));

    connection.receiver.streams[0].end(Buffer.alloc(512)); // ~5 ms
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stt.transcribeUtterance).not.toHaveBeenCalled();
    expect(ingestUtterance).not.toHaveBeenCalled();
    client.stop();
  });

  it("still ingests when the display webhook fails", async () => {
    const { client, connection, relay, ingestUtterance } = await joinedClient();
    relay.postTranscript.mockRejectedValueOnce(new Error("webhook 404"));

    connection.receiver.speaking.emit("start", "user-1");
    await vi.waitFor(() => expect(connection.receiver.streams).toHaveLength(1));
    connection.receiver.streams[0].end(HALF_SECOND_PCM);

    await vi.waitFor(() => expect(ingestUtterance).toHaveBeenCalledTimes(1));
    client.stop();
  });
});
