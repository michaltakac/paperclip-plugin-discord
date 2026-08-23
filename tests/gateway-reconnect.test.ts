import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  connectGateway,
  ReconnectPolicy,
  BASE_RECONNECT_MS,
  MAX_BACKOFF_MS,
  STABLE_CONNECTION_MS,
  RATE_LIMIT_COOLDOWN_MS,
  CONNECT_TIMEOUT_MS,
  IDENTIFY_BUDGET_MAX,
  IDENTIFY_BUDGET_WINDOW_MS,
} from "../src/gateway.js";

// ---------------------------------------------------------------------------
// Regression tests for the 2026-07-22 reconnect storm (276k gateway connects
// in one day → Discord reset the bot token) and the months-long baseline bug
// where every connection was zombie-closed by Discord ~50s after connect.
// Root cause for both: socket state (ws, heartbeat timers) shared across
// overlapping connections, plus untracked reconnect timers multiplying loops.
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 41_250;

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

  // --- server-side helpers ---
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
    await this.serverMessage({ op: 10, d: { heartbeat_interval: HEARTBEAT_INTERVAL_MS }, s: null, t: null });
  }

  async ready(sessionId = "sess-1"): Promise<void> {
    await this.serverMessage({
      op: 0,
      d: { session_id: sessionId, resume_gateway_url: "wss://resume.test" },
      s: 1,
      t: "READY",
    });
  }

  async resumed(): Promise<void> {
    await this.serverMessage({ op: 0, d: {}, s: 2, t: "RESUMED" });
  }

  async ack(): Promise<void> {
    await this.serverMessage({ op: 11, d: null, s: null, t: null });
  }

  identifies(): number {
    return this.sent.filter((p) => p.op === 2).length;
  }

  resumes(): number {
    return this.sent.filter((p) => p.op === 6).length;
  }

  heartbeats(): number {
    return this.sent.filter((p) => p.op === 1).length;
  }
}

function buildCtx() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    http: {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ url: "wss://gateway.test" }),
      }),
    },
  } as any;
}

async function openGateway(options: Record<string, unknown> = {}) {
  const ctx = buildCtx();
  const gateway = await connectGateway(ctx, "test-token", async () => ({}), undefined, options);
  return { ctx, gateway };
}

/** Bring a socket through open → hello → identify/resume without READY. */
async function handshake(sock: FakeWebSocket) {
  sock.serverOpen();
  await sock.hello();
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  // Deterministic timing: jitter factors become exactly their maximum.
  vi.spyOn(Math, "random").mockReturnValue(1);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("gateway happy path", () => {
  it("identifies once, heartbeats on its own socket, and stays on one connection", async () => {
    const { gateway } = await openGateway();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const sock = FakeWebSocket.instances[0];

    await handshake(sock);
    expect(sock.identifies()).toBe(1);
    await sock.ready();

    // First heartbeat fires after jitter (≤ interval), then steadily.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(sock.heartbeats()).toBe(1);
    await sock.ack();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(sock.heartbeats()).toBe(2);
    await sock.ack();

    // No reconnects, no extra sockets.
    expect(FakeWebSocket.instances).toHaveLength(1);
    gateway.close();
    expect(sock.closeCalls.at(-1)).toEqual({ code: 1000, reason: "Plugin shutting down" });
  });

  it("closes the zombied socket when a heartbeat is never acked", async () => {
    const { ctx } = await openGateway();
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);
    await sock.ready();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS); // beat 1, never acked
    expect(sock.heartbeats()).toBe(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS); // detected: close, not send
    expect(sock.heartbeats()).toBe(1);
    expect(sock.closeCalls.at(-1)?.code).toBe(4000);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Heartbeat ACK not received, forcing reconnect",
      expect.anything(),
    );
  });
});

describe("reconnect-storm regression (loop multiplication)", () => {
  it("op 7 reconnect: the superseded socket's close/handlers can never spawn a second loop", async () => {
    await openGateway();
    const first = FakeWebSocket.instances[0];
    await handshake(first);
    await first.ready();

    // Discord asks for a reconnect.
    await first.serverMessage({ op: 7, d: null, s: null, t: null });
    // Old socket was closed with a resumable (non-1000) code and detached.
    expect(first.closeCalls.at(-1)?.code).toBe(4000);
    expect(first.onclose).toBeNull();
    expect(first.onmessage).toBeNull();

    await vi.advanceTimersByTimeAsync(2_500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1];

    // New socket resumes rather than re-identifying.
    await handshake(second);
    expect(second.resumes()).toBe(1);
    expect(second.identifies()).toBe(0);
    await second.resumed();

    // The stale socket firing events (as during the storm) must be inert.
    first.serverClose(1000);
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS * 2);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("keeps exactly one pending reconnect even when close events pile up", async () => {
    await openGateway();
    const first = FakeWebSocket.instances[0];
    await handshake(first);
    await first.ready();

    first.serverClose(1000);
    // Duplicate close from the same socket (stale handler scenario).
    first.serverClose(1000);
    first.serverClose(1006);

    // If each close had scheduled its own timer they would all fire at the
    // same base delay — advancing exactly that far must create ONE socket.
    await vi.advanceTimersByTimeAsync(BASE_RECONNECT_MS);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("tears down a socket that never becomes ready (connect watchdog)", async () => {
    const { ctx } = await openGateway();
    const first = FakeWebSocket.instances[0];
    // Socket hangs in CONNECTING: no open, no error, no close.
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(first.closeCalls.at(-1)).toEqual({ code: 4000, reason: "Connect timeout" });
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Gateway connection not ready within timeout, retrying",
      expect.objectContaining({ generation: 1 }),
    );
    await vi.advanceTimersByTimeAsync(BASE_RECONNECT_MS);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("recovers when a handshake errors without ever emitting a close event", async () => {
    // Regression: 2026-07-23 — generation 8 got a WebSocket error 11s into
    // CONNECTING, no close event followed, and the gateway hung for 8+ hours.
    await openGateway();
    const first = FakeWebSocket.instances[0];
    first.onerror?.({});
    expect(first.closeCalls.at(-1)).toEqual({ code: 4000, reason: "Socket error before established" });
    expect(first.onclose).toBeNull(); // detached: a late close event stays inert

    await vi.advanceTimersByTimeAsync(BASE_RECONNECT_MS);
    expect(FakeWebSocket.instances).toHaveLength(2);
    // And only one reconnect loop exists afterwards.
    const second = FakeWebSocket.instances[1];
    await handshake(second);
    await second.ready();
    await vi.advanceTimersByTimeAsync(STABLE_CONNECTION_MS);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("the old socket's heartbeat timers die with it and never clear the new socket's", async () => {
    await openGateway();
    const first = FakeWebSocket.instances[0];
    await handshake(first);
    await first.ready();

    // Old socket dies → reconnect (unstable: 5s base with max jitter).
    first.serverClose(1000);
    await vi.advanceTimersByTimeAsync(BASE_RECONNECT_MS);
    const second = FakeWebSocket.instances[1];
    await handshake(second);
    await second.resumed();

    // The new socket must heartbeat on ITS OWN connection — this is the exact
    // baseline bug where heartbeats stopped and Discord zombie-closed every
    // socket ~50s after connect, ~1,700 times/day for months.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(second.heartbeats()).toBeGreaterThan(0);
    await second.ack();
    const beats = second.heartbeats();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(second.heartbeats()).toBe(beats + 1);
    expect(first.heartbeats()).toBe(0);
  });
});

describe("backoff", () => {
  it("doubles the delay for unstable connections and resets only after a stable one", async () => {
    await openGateway();

    // Round 1: dies right after READY (unstable) → next delay = 5s (max jitter).
    let sock = FakeWebSocket.instances[0];
    await handshake(sock);
    await sock.ready();
    sock.serverClose(1000);

    await vi.advanceTimersByTimeAsync(BASE_RECONNECT_MS - 1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Round 2: unstable again → 10s.
    sock = FakeWebSocket.instances[1];
    await handshake(sock);
    await sock.resumed();
    sock.serverClose(1000);
    await vi.advanceTimersByTimeAsync(2 * BASE_RECONNECT_MS - 1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // Round 3: stays up past the stability threshold → backoff resets to 5s.
    sock = FakeWebSocket.instances[2];
    await handshake(sock);
    await sock.resumed();
    await sock.ack(); // keep heartbeat pipeline clean while time passes
    await vi.advanceTimersByTimeAsync(STABLE_CONNECTION_MS + 1_000);
    sock.serverClose(1000);
    await vi.advanceTimersByTimeAsync(BASE_RECONNECT_MS);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("caps the backoff at MAX_BACKOFF_MS", async () => {
    await openGateway();
    // Enough unstable rounds to pass the cap: 5s→10s→…
    for (let round = 0; ; round++) {
      const sock = FakeWebSocket.instances.at(-1)!;
      await handshake(sock);
      sock.serverClose(1006);
      const expected = Math.min(BASE_RECONNECT_MS * 2 ** round, MAX_BACKOFF_MS);
      await vi.advanceTimersByTimeAsync(expected);
      expect(FakeWebSocket.instances).toHaveLength(round + 2);
      if (expected === MAX_BACKOFF_MS) break;
    }

    // One more unstable round: still exactly MAX_BACKOFF_MS, not more.
    const count = FakeWebSocket.instances.length;
    const sock = FakeWebSocket.instances.at(-1)!;
    await handshake(sock);
    sock.serverClose(1006);
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS - 1);
    expect(FakeWebSocket.instances).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(count + 1);
  });

  it("honors close 4008 (rate limited) with a long cooldown", async () => {
    const { ctx } = await openGateway();
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);
    await sock.ready();
    sock.serverClose(4008, "Rate limited");

    await vi.advanceTimersByTimeAsync(RATE_LIMIT_COOLDOWN_MS - 1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Gateway rate limited by Discord (close 4008), cooling down",
      { cooldownMs: RATE_LIMIT_COOLDOWN_MS },
    );
  });
});

describe("permanent failure", () => {
  it("stops forever on fatal close codes and reports health", async () => {
    const onPermanentFailure = vi.fn();
    await openGateway({ onPermanentFailure });
    const sock = FakeWebSocket.instances[0];
    await handshake(sock);
    sock.serverClose(4004, "Authentication failed.");

    await vi.advanceTimersByTimeAsync(IDENTIFY_BUDGET_WINDOW_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onPermanentFailure).toHaveBeenCalledWith(
      expect.stringContaining("4004"),
      expect.objectContaining({ code: 4004 }),
    );
  });

  it("stops reconnecting when the identify budget is exhausted", async () => {
    const policy = new ReconnectPolicy();
    for (let i = 0; i < IDENTIFY_BUDGET_MAX; i++) {
      expect(policy.tryConsumeIdentify()).toBe(true);
    }
    const onPermanentFailure = vi.fn();
    await openGateway({ onPermanentFailure, reconnectPolicy: policy });

    const sock = FakeWebSocket.instances[0];
    await handshake(sock);

    // Budget spent → no IDENTIFY sent, socket closed, no reconnect ever.
    expect(sock.identifies()).toBe(0);
    expect(sock.closeCalls.length).toBeGreaterThan(0);
    expect(onPermanentFailure).toHaveBeenCalledWith(
      expect.stringContaining("identify budget exhausted"),
      expect.anything(),
    );
    await vi.advanceTimersByTimeAsync(IDENTIFY_BUDGET_WINDOW_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("ReconnectPolicy", () => {
  it("meters identifies over a rolling 24h window", () => {
    let now = 1_000_000;
    const policy = new ReconnectPolicy(() => now);

    for (let i = 0; i < IDENTIFY_BUDGET_MAX; i++) {
      expect(policy.tryConsumeIdentify()).toBe(true);
    }
    expect(policy.tryConsumeIdentify()).toBe(false);
    expect(policy.identifiesInWindow()).toBe(IDENTIFY_BUDGET_MAX);

    // Window slides: after 24h the budget frees up again.
    now += IDENTIFY_BUDGET_WINDOW_MS + 1;
    expect(policy.tryConsumeIdentify()).toBe(true);
  });

  it("jitters delays between 50% and 100% of the current backoff", () => {
    (Math.random as any).mockRestore?.();
    const policy = new ReconnectPolicy();
    for (let i = 0; i < 50; i++) {
      const stablePolicy = new ReconnectPolicy();
      const delay = stablePolicy.nextDelay(true);
      expect(delay).toBeGreaterThanOrEqual(BASE_RECONNECT_MS / 2);
      expect(delay).toBeLessThanOrEqual(BASE_RECONNECT_MS);
    }
    // penalize() pins the next delay to the cap range.
    policy.penalize();
    const delay = policy.nextDelay(false);
    expect(delay).toBeGreaterThanOrEqual(MAX_BACKOFF_MS / 2);
    expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });
});
