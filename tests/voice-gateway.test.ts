import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectGateway } from "../src/gateway.js";

// ---------------------------------------------------------------------------
// The gateway's voice surface (opt-in via `enableVoice`).
//
// Two invariants matter beyond "it works", because voice rides the SAME socket
// the text path depends on (#71 fixed a reconnect storm caused by socket state
// leaking across connections):
//
//   1. `sendPayload` must resolve the CURRENT socket at call time and go
//      through the readyState guard — never a captured socket reference.
//   2. A misbehaving voice handler must not break gateway dispatch for
//      interactions or messages.
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 41_250;
const GUILD_VOICE_STATES_INTENT = 128;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: Array<{ op: number; d: unknown }> = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void | Promise<void>) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("InvalidStateError: Sent before connected");
    }
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
  }

  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  async serverMessage(payload: Record<string, unknown>): Promise<void> {
    await this.onmessage?.({ data: JSON.stringify(payload) });
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  async hello(): Promise<void> {
    await this.serverMessage({
      op: 10,
      d: { heartbeat_interval: HEARTBEAT_INTERVAL_MS },
      s: null,
      t: null,
    });
  }

  async ready(sessionId = "sess-1"): Promise<void> {
    await this.serverMessage({
      op: 0,
      d: { session_id: sessionId, resume_gateway_url: "wss://resume.test" },
      s: 1,
      t: "READY",
    });
  }

  identifyIntents(): number | undefined {
    const identify = this.sent.find((p) => p.op === 2);
    return identify ? (identify.d as { intents: number }).intents : undefined;
  }

  voicePayloads(): Array<{ op: number; d: unknown }> {
    return this.sent.filter((p) => p.op === 4);
  }
}

function buildCtx() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    http: {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ url: "wss://gateway.test" }),
      }),
    },
  } as any;
}

async function openGateway(options: Record<string, unknown> = {}, onMessage?: any) {
  const ctx = buildCtx();
  const gateway = await connectGateway(ctx, "test-token", async () => ({}), onMessage, options);
  return { ctx, gateway };
}

async function handshake(sock: FakeWebSocket) {
  sock.serverOpen();
  await sock.hello();
  await sock.ready();
}

const VOICE_STATE = {
  guild_id: "g1",
  channel_id: "c1",
  user_id: "u1",
  session_id: "vsess",
};
const VOICE_SERVER = { token: "vt", guild_id: "g1", endpoint: "voice.test" };

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.spyOn(Math, "random").mockReturnValue(1);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("gateway voice surface — gating", () => {
  it("is absent by default and does not request the voice intent", async () => {
    const { gateway } = await openGateway();
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);

    expect(gateway.voice).toBeUndefined();
    expect(sock.identifyIntents()! & GUILD_VOICE_STATES_INTENT).toBe(0);
  });

  it("adds GUILD_VOICE_STATES and exposes the handle when enableVoice is true", async () => {
    const { gateway } = await openGateway({ enableVoice: true });
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);

    expect(gateway.voice).toBeDefined();
    expect(sock.identifyIntents()! & GUILD_VOICE_STATES_INTENT).toBe(
      GUILD_VOICE_STATES_INTENT,
    );
  });

  it("does not dispatch voice events when voice is disabled", async () => {
    const { gateway } = await openGateway();
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);

    // No handle to subscribe through, and the dispatch must not throw.
    expect(gateway.voice).toBeUndefined();
    await sock.serverMessage({ op: 0, d: VOICE_STATE, s: 2, t: "VOICE_STATE_UPDATE" });
    await sock.serverMessage({ op: 0, d: VOICE_SERVER, s: 3, t: "VOICE_SERVER_UPDATE" });
  });
});

describe("gateway voice surface — dispatch", () => {
  it("delivers VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE to subscribers", async () => {
    const { gateway } = await openGateway({ enableVoice: true });
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);

    const onState = vi.fn();
    const onServer = vi.fn();
    gateway.voice!.onVoiceStateUpdate(onState);
    gateway.voice!.onVoiceServerUpdate(onServer);

    await sock.serverMessage({ op: 0, d: VOICE_STATE, s: 2, t: "VOICE_STATE_UPDATE" });
    await sock.serverMessage({ op: 0, d: VOICE_SERVER, s: 3, t: "VOICE_SERVER_UPDATE" });

    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ user_id: "u1" }));
    expect(onServer).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "voice.test" }));
  });

  it("stops delivering after the returned unsubscribe is called", async () => {
    const { gateway } = await openGateway({ enableVoice: true });
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);

    const onState = vi.fn();
    const unsubscribe = gateway.voice!.onVoiceStateUpdate(onState);

    await sock.serverMessage({ op: 0, d: VOICE_STATE, s: 2, t: "VOICE_STATE_UPDATE" });
    expect(onState).toHaveBeenCalledTimes(1);

    unsubscribe();
    await sock.serverMessage({ op: 0, d: VOICE_STATE, s: 3, t: "VOICE_STATE_UPDATE" });
    expect(onState).toHaveBeenCalledTimes(1);
  });

  it("a throwing voice handler is logged and never breaks message dispatch", async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const { ctx, gateway } = await openGateway({ enableVoice: true }, onMessage);
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);

    gateway.voice!.onVoiceStateUpdate(() => {
      throw new Error("handler blew up");
    });

    await sock.serverMessage({ op: 0, d: VOICE_STATE, s: 2, t: "VOICE_STATE_UPDATE" });
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Voice state update handler error",
      expect.objectContaining({ error: "handler blew up" }),
    );

    // The shared dispatch switch still works for the text path.
    await sock.serverMessage({
      op: 0,
      d: { id: "m1", channel_id: "c1", content: "hi", author: { id: "a", username: "a" } },
      s: 3,
      t: "MESSAGE_CREATE",
    });
    expect(onMessage).toHaveBeenCalledOnce();
  });
});

describe("gateway voice surface — sendPayload safety", () => {
  it("sends op 4 on the open socket", async () => {
    const { gateway } = await openGateway({ enableVoice: true });
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);

    const sent = gateway.voice!.sendPayload({ op: 4, d: { guild_id: "g1" } });

    expect(sent).toBe(true);
    expect(sock.voicePayloads()).toHaveLength(1);
  });

  it("returns false instead of throwing when the socket is not OPEN (readyState guard)", async () => {
    // The regression this guards: an unguarded ws.send on a CONNECTING or
    // CLOSED socket throws InvalidStateError and takes the worker down.
    const { gateway } = await openGateway({ enableVoice: true });
    const sock = FakeWebSocket.instances[0];

    // Still CONNECTING — no handshake yet.
    expect(sock.readyState).toBe(FakeWebSocket.CONNECTING);
    expect(() => gateway.voice!.sendPayload({ op: 4, d: {} })).not.toThrow();
    expect(gateway.voice!.sendPayload({ op: 4, d: {} })).toBe(false);
    expect(sock.voicePayloads()).toHaveLength(0);
  });

  it("routes to the CURRENT socket after a reconnect, never the superseded one", async () => {
    const { gateway } = await openGateway({ enableVoice: true });
    const first = FakeWebSocket.instances[0];
    await handshake(first);

    // Discord drops the connection; the gateway reconnects on its own socket.
    first.serverClose(4000, "transient");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);

    const second = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    second.serverOpen();
    await second.hello();
    await second.serverMessage({ op: 0, d: {}, s: 5, t: "RESUMED" });

    const firstBefore = first.voicePayloads().length;
    expect(gateway.voice!.sendPayload({ op: 4, d: { guild_id: "g1" } })).toBe(true);

    expect(second.voicePayloads()).toHaveLength(1);
    expect(first.voicePayloads()).toHaveLength(firstBefore);
  });

  it("returns false after the gateway is closed", async () => {
    const { gateway } = await openGateway({ enableVoice: true });
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);

    gateway.close();
    expect(gateway.voice!.sendPayload({ op: 4, d: {} })).toBe(false);
  });

  it("close() drops voice subscribers so a stopped plugin dispatches nothing", async () => {
    const { gateway } = await openGateway({ enableVoice: true });
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);

    const onState = vi.fn();
    gateway.voice!.onVoiceStateUpdate(onState);
    gateway.close();

    await sock.serverMessage({ op: 0, d: VOICE_STATE, s: 9, t: "VOICE_STATE_UPDATE" });
    expect(onState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F2 — the readiness boundary voice joins on.
//
// An op-4 voice-state-update is only deliverable once the socket has
// identified: before that `sendPayload` refuses it (no OPEN socket) or Discord
// has no session to attach it to. @discordjs/voice treats a join whose first
// send was refused as terminal — it does not retry when the adapter becomes
// usable later — so voice must never join off the back of `connectGateway()`
// returning. It joins on this boundary, and on nothing else.
// ---------------------------------------------------------------------------

describe("gateway voice surface — readiness", () => {
  it("does not signal readiness before the socket has identified", async () => {
    const { gateway } = await openGateway({ enableVoice: true });
    const sock = FakeWebSocket.instances[0];
    const ready = vi.fn();

    gateway.voice!.onGatewayReady(ready);
    sock.serverOpen();
    await sock.hello();
    await vi.advanceTimersByTimeAsync(0);

    // HELLO and IDENTIFY have gone out, but READY has not come back.
    expect(ready).not.toHaveBeenCalled();
  });

  it("signals on READY and again on every RESUMED", async () => {
    const { gateway } = await openGateway({ enableVoice: true });
    const sock = FakeWebSocket.instances[0];
    const ready = vi.fn();
    gateway.voice!.onGatewayReady(ready);

    await handshake(sock);
    expect(ready).toHaveBeenCalledTimes(1);

    await sock.serverMessage({ op: 0, d: {}, s: 2, t: "RESUMED" });
    expect(ready).toHaveBeenCalledTimes(2);
  });

  it("delivers the boundary to a subscriber that arrives after it", async () => {
    // A reused gateway is already past READY and has no reason to emit another
    // one; a voice client subscribing then must not wait forever.
    const { gateway } = await openGateway({ enableVoice: true });
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);

    const late = vi.fn();
    gateway.voice!.onGatewayReady(late);
    expect(late).not.toHaveBeenCalled(); // never re-entrant with subscribe

    await vi.advanceTimersByTimeAsync(0);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("stops treating a closed connection as ready", async () => {
    const { gateway } = await openGateway({ enableVoice: true });
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);
    sock.serverClose(4000, "closed");

    const late = vi.fn();
    gateway.voice!.onGatewayReady(late);
    await vi.advanceTimersByTimeAsync(0);

    expect(late).not.toHaveBeenCalled();
  });

  it("unsubscribes cleanly and stops delivering", async () => {
    const { gateway } = await openGateway({ enableVoice: true });
    const sock = FakeWebSocket.instances[0];
    const ready = vi.fn();
    const off = gateway.voice!.onGatewayReady(ready);

    await handshake(sock);
    expect(ready).toHaveBeenCalledTimes(1);

    off();
    await sock.serverMessage({ op: 0, d: {}, s: 2, t: "RESUMED" });
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("keeps dispatch alive when a readiness handler throws", async () => {
    const { ctx, gateway } = await openGateway({ enableVoice: true });
    const good = vi.fn();
    gateway.voice!.onGatewayReady(() => {
      throw new Error("voice handler exploded");
    });
    gateway.voice!.onGatewayReady(good);

    const sock = FakeWebSocket.instances[0];
    await expect(handshake(sock)).resolves.toBeUndefined();

    expect(good).toHaveBeenCalledTimes(1);
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("does not signal readiness at all when voice is disabled", async () => {
    const { gateway } = await openGateway();
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);
    expect(gateway.voice).toBeUndefined();
  });
});
