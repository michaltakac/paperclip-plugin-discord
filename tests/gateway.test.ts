import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

function makeCtx(): PluginContext {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    http: {
      fetch: vi.fn(),
    },
    metrics: { emit: vi.fn() },
  } as unknown as PluginContext;
}

describe("connectGateway", () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it("returns no-op and warns when WebSocket is not available", async () => {
    // Simulate an environment without WebSocket (Node < 21)
    // @ts-expect-error -- intentionally deleting global for test
    delete globalThis.WebSocket;

    const { connectGateway } = await import("../src/gateway.js");
    const ctx = makeCtx();
    const handler = vi.fn();

    const result = await connectGateway(ctx, "fake-token", handler);

    expect(result).toEqual({ close: expect.any(Function) });
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("WebSocket is not available"),
    );
    expect(handler).not.toHaveBeenCalled();
    result.close(); // should not throw
  });

  it("does not throw 'Sent before connected' when a heartbeat tick fires on a CLOSED socket (2026-05-12 crash regression)", async () => {
    // Reproduce the InvalidStateError that crashed the worker for two weeks:
    // a heartbeat scheduled via setInterval fired between onclose firing and
    // the interval being cleared, calling ws.send on a CLOSED socket.
    //
    // Test must fail without the safeSend readyState guard. Two timing
    // constraints make this deterministic and prevent the ACK-timeout
    // teardown from clearing the interval BEFORE the regression-tick fires
    // (which previously made the test pass for the wrong reason):
    //
    //   1. Math.random is mocked to 0 so jitter is zero — first heartbeat
    //      sends at t=0 instead of at jitter ms.
    //   2. heartbeat_interval is large (10_000ms) so the ACK timeout from
    //      the first send is scheduled for t=20_000ms, well after the
    //      regression-exercising tick at t=10_000ms.
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    class FlakyFakeWebSocket {
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      static instances: FlakyFakeWebSocket[] = [];

      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      sent: string[] = [];
      readyState = 1; // OPEN

      constructor(_url: string) {
        FlakyFakeWebSocket.instances.push(this);
      }

      send(payload: string) {
        if (this.readyState !== 1) {
          // Mirror the real WHATWG WebSocket behaviour.
          throw new DOMException("Sent before connected.", "InvalidStateError");
        }
        this.sent.push(payload);
      }

      close() {
        this.readyState = 3;
      }
    }

    // Expose OPEN/CLOSED on the static `WebSocket` reference the source reads.
    globalThis.WebSocket = FlakyFakeWebSocket as unknown as typeof WebSocket;

    // Re-import to pick up the patched WebSocket binding.
    vi.resetModules();
    const { connectGateway } = await import("../src/gateway.js");
    const ctx = makeCtx();
    // Heartbeat ack timeout writes a reconnection metric — stub it.
    (ctx as unknown as { metrics: { write: () => Promise<void> } }).metrics = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    (ctx.http.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ url: "wss://gateway.discord.test" }),
    });

    const result = await connectGateway(ctx, "fake-token", vi.fn(), undefined, {
      listenForMessages: false,
      includeMessageContent: false,
    });

    const socket = FlakyFakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    // HELLO with a LARGE interval — keeps the ACK timeout far in the future
    // (at intervalMs * 2 = 20_000ms) so the regression tick at t=10_000ms
    // lands before any teardown clears the heartbeat interval.
    const intervalMs = 10_000;
    socket.onmessage?.({
      data: JSON.stringify({
        op: 10,
        d: { heartbeat_interval: intervalMs },
        s: null,
        t: null,
      }),
    });

    // jitter is 0, so the first heartbeat sends as soon as the next tick runs.
    // Advance 1ms to flush the jitter setTimeout(0) — first send fires here.
    vi.advanceTimersByTime(1);
    const firstSendCount = socket.sent.filter((p) => {
      try {
        return JSON.parse(p).op === 1;
      } catch {
        return false;
      }
    }).length;
    expect(firstSendCount).toBe(1);

    // Simulate the socket transitioning to CLOSED *before* the next interval
    // tick — exactly the race the real bug exercised.
    socket.readyState = FlakyFakeWebSocket.CLOSED;

    // Advance to t=intervalMs, which fires the FIRST interval tick. The ACK
    // timeout from t=0 was scheduled for t=2*intervalMs=20_000, so it has
    // NOT fired yet — the heartbeat interval is still live and tries to tick
    // on the CLOSED socket. Without the readyState guard, ws.send throws
    // InvalidStateError out of the setInterval callback and vitest re-throws
    // from advanceTimersByTime. With the guard, safeSend returns false and
    // no exception escapes.
    expect(() => vi.advanceTimersByTime(intervalMs)).not.toThrow();

    // No additional send happened (safeSend correctly skipped the CLOSED ws).
    const finalSendCount = socket.sent.filter((p) => {
      try {
        return JSON.parse(p).op === 1;
      } catch {
        return false;
      }
    }).length;
    expect(finalSendCount).toBe(firstSendCount);

    result.close();
    randomSpy.mockRestore();
    vi.useRealTimers();
  });

  it("uses guild-only intents when message subscriptions are disabled", async () => {
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      sent: string[] = [];

      constructor(_url: string) {
        FakeWebSocket.instances.push(this);
      }

      send(payload: string) {
        this.sent.push(payload);
      }

      close() {}
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const { connectGateway } = await import("../src/gateway.js");
    const ctx = makeCtx();
    (ctx.http.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ url: "wss://gateway.discord.test" }),
    });

    const result = await connectGateway(ctx, "fake-token", vi.fn(), undefined, {
      listenForMessages: false,
      includeMessageContent: false,
    });

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    socket.onmessage?.({
      data: JSON.stringify({
        op: 10,
        d: { heartbeat_interval: 10000 },
        s: null,
        t: null,
      }),
    });

    const identify = JSON.parse(socket.sent[0] ?? "{}");
    expect(identify.op).toBe(2);
    expect(identify.d.intents).toBe(1);

    result.close();
  });
});

describe("reaction intent", () => {
  let originalWebSocket: typeof globalThis.WebSocket;
  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void | Promise<void>) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    sent: string[] = [];
    constructor(_url: string) {
      FakeWebSocket.instances.push(this);
    }
    send(payload: string) {
      this.sent.push(payload);
    }
    close() {}
  }

  async function connect(options: Record<string, unknown>) {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const { connectGateway } = await import("../src/gateway.js");
    const ctx = makeCtx();
    (ctx.http.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ url: "wss://gateway.discord.test" }),
    });
    const handle = await connectGateway(ctx, "fake-token", vi.fn(), undefined, {
      listenForMessages: false,
      includeMessageContent: false,
      ...options,
    });
    const socket = FakeWebSocket.instances[0]!;
    await socket.onmessage?.({
      data: JSON.stringify({ op: 10, d: { heartbeat_interval: 10000 }, s: null, t: null }),
    });
    return { handle, socket, ctx };
  }

  it("requests GUILD_MESSAGE_REACTIONS only when a reaction handler is given", async () => {
    const without = await connect({});
    expect(JSON.parse(without.socket.sent[0]!).d.intents).toBe(1);
    without.handle.close();

    const withHandler = await connect({ onReaction: vi.fn() });
    expect(JSON.parse(withHandler.socket.sent[0]!).d.intents).toBe(1 | 1024);
    withHandler.handle.close();
  });

  it("dispatches MESSAGE_REACTION_ADD, and a throwing handler does not escape", async () => {
    const onReaction = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const { handle, socket, ctx } = await connect({ onReaction });
    const event = {
      user_id: "1",
      channel_id: "2",
      message_id: "3",
      guild_id: "4",
      emoji: { id: null, name: "🧠" },
    };
    const frame = { data: JSON.stringify({ op: 0, d: event, s: 1, t: "MESSAGE_REACTION_ADD" }) };

    await socket.onmessage?.(frame);
    await socket.onmessage?.(frame);

    expect(onReaction).toHaveBeenCalledTimes(2);
    expect(onReaction).toHaveBeenLastCalledWith(event);
    expect(ctx.logger.error).toHaveBeenCalledWith("Gateway reaction handler error", { error: "boom" });
    handle.close();
  });
});

describe("respondViaCallback", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("handles 204 responses without error (Bug 1 regression)", async () => {
    // Simulate Discord returning 204 No Content on successful callback
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: () => Promise.resolve(""),
    }) as unknown as typeof fetch;

    const { respondViaCallback } = await import("../src/gateway.js");
    const ctx = makeCtx();

    await respondViaCallback(ctx, "interaction-1", "token-1", {
      type: 4,
      data: { content: "Hello" },
    });

    // Should not log any error or warning
    expect(ctx.logger.error).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalled();

    // Should have called native fetch, not ctx.http.fetch
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/interactions/interaction-1/token-1/callback"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("logs warning on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad Request"),
    }) as unknown as typeof fetch;

    const { respondViaCallback } = await import("../src/gateway.js");
    const ctx = makeCtx();

    await respondViaCallback(ctx, "interaction-1", "token-1", { type: 4 });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Interaction callback failed",
      expect.objectContaining({ status: 400 }),
    );
  });
});
