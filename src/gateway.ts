import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DISCORD_API_BASE, METRIC_NAMES } from "./constants.js";

const GATEWAY_VERSION = "10";
const GATEWAY_ENCODING = "json";
const GUILD_INTENT = 1;
const GUILD_MESSAGES_INTENT = 512;
const MESSAGE_CONTENT_INTENT = 32768;

// --- Reconnect policy tuning (exported for tests) ---
export const BASE_RECONNECT_MS = 5_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
// A connection must stay READY/RESUMED this long before we consider it stable
// and reset the backoff. Resetting on READY alone is what let the 2026-07-22
// storm run at full speed: sockets reached READY, died seconds later, and every
// reconnect used the base delay.
export const STABLE_CONNECTION_MS = 60_000;
export const RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;
// A new socket must reach READY/RESUMED within this window or it is torn down
// and retried. Handshake failures do not reliably emit a close event (observed
// 2026-07-23: an error during CONNECTING with no close left the gateway hung
// for 8+ hours), so recovery cannot depend on onclose alone.
export const CONNECT_TIMEOUT_MS = 60_000;
// Discord resets the bot token after 1000 identifies in 24h. Budget well below
// that so a bug can never burn the token again.
export const IDENTIFY_BUDGET_MAX = 500;
export const IDENTIFY_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPEATED_FAILURE_LOG_THRESHOLD = 5;

// Close codes that no amount of reconnecting can recover from: retrying would
// only burn identify budget (and eventually the bot token itself).
const FATAL_CLOSE_CODES: Record<number, string> = {
  4004: "Authentication failed",
  4010: "Invalid shard",
  4011: "Sharding required",
  4012: "Invalid API version",
  4013: "Invalid intents",
  4014: "Disallowed intents",
};

// Close codes after which the old session is gone — reconnect must re-identify.
const NON_RESUMABLE_CLOSE_CODES = new Set([4007, 4009]);
const RATE_LIMITED_CLOSE_CODE = 4008;

interface GatewayPayload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

interface ReadyEvent {
  session_id: string;
  resume_gateway_url: string;
}

interface InteractionCreateEvent {
  id: string;
  token: string;
  type: number;
  data?: Record<string, unknown>;
  member?: { user: { username: string } };
  guild_id?: string;
  channel_id?: string;
}

export interface MessageCreateEvent {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  message_reference?: {
    message_id: string;
    channel_id: string;
    guild_id?: string;
  };
}

type InteractionHandler = (interaction: InteractionCreateEvent) => Promise<unknown>;
type MessageHandler = (message: MessageCreateEvent) => Promise<void>;

export interface GatewayOptions {
  listenForMessages?: boolean;
  includeMessageContent?: boolean;
  /**
   * Called when the gateway gives up permanently (fatal close code or identify
   * budget exhausted). The worker uses this to surface plugin health instead of
   * silently running without a gateway connection.
   */
  onPermanentFailure?: (message: string, details?: Record<string, unknown>) => void;
  /** Test seam — production callers omit this. */
  reconnectPolicy?: ReconnectPolicy;
}

/**
 * Backoff + identify-budget bookkeeping, kept separate from socket plumbing so
 * it can be unit-tested with a fake clock.
 */
export class ReconnectPolicy {
  private backoffMs = BASE_RECONNECT_MS;
  private identifyTimes: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Delay before the next reconnect attempt. `wasStable` means the previous
   * connection stayed up for STABLE_CONNECTION_MS after READY/RESUMED — only
   * that resets the backoff; consecutive unstable connections double it up to
   * MAX_BACKOFF_MS. The 50–100% jitter avoids thundering-herd reconnects.
   */
  nextDelay(wasStable: boolean): number {
    if (wasStable) this.backoffMs = BASE_RECONNECT_MS;
    const delay = Math.floor(this.backoffMs * (0.5 + Math.random() * 0.5));
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    return delay;
  }

  /** Push the backoff straight to the cap (rate-limit close 4008). */
  penalize(): void {
    this.backoffMs = MAX_BACKOFF_MS;
  }

  /**
   * Returns true (and records the spend) if an IDENTIFY may be sent now.
   * RESUME attempts do not count — Discord's limit applies to identifies only.
   */
  tryConsumeIdentify(): boolean {
    const cutoff = this.now() - IDENTIFY_BUDGET_WINDOW_MS;
    this.identifyTimes = this.identifyTimes.filter((t) => t > cutoff);
    if (this.identifyTimes.length >= IDENTIFY_BUDGET_MAX) return false;
    this.identifyTimes.push(this.now());
    return true;
  }

  identifiesInWindow(): number {
    const cutoff = this.now() - IDENTIFY_BUDGET_WINDOW_MS;
    return this.identifyTimes.filter((t) => t > cutoff).length;
  }
}

export async function respondViaCallback(
  ctx: PluginContext,
  interactionId: string,
  interactionToken: string,
  responseData: unknown,
): Promise<void> {
  const url = `${DISCORD_API_BASE}/interactions/${interactionId}/${interactionToken}/callback`;
  try {
    // Use native fetch instead of ctx.http.fetch because Discord returns 204
    // on success.  The SDK's http.fetch reconstructs a Response object via
    // `new Response(body, { status })` which throws when the body is non-null
    // and the status is a null-body status (204).  Native fetch handles this
    // correctly and the interaction callback does not need SDK audit tracing.
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(responseData),
    });
    if (!response.ok) {
      const text = await response.text();
      ctx.logger.warn("Interaction callback failed", {
        status: response.status,
        body: text,
      });
    }
  } catch (error) {
    ctx.logger.error("Interaction callback error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Per-connection state. Every timer and flag lives on the connection that owns
 * it — never in variables shared across connections. The 2026-07-22 reconnect
 * storm (276k connects/day) and the months-long ~50s baseline close cycle both
 * came from overlapping sockets sharing one `ws`/`heartbeatInterval`/
 * `heartbeatAckTimeout`: stale handlers cleared the live socket's heartbeat
 * timers, Discord zombie-closed the silent socket (code 1000) every
 * ~heartbeat interval, and each stale onclose scheduled its own reconnect loop.
 */
interface GatewaySocket {
  gen: number;
  ws: WebSocket;
  connectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatStartTimer: ReturnType<typeof setTimeout> | null;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  awaitingAck: boolean;
  readyAt: number | null;
}

export async function connectGateway(
  ctx: PluginContext,
  token: string,
  onInteraction: InteractionHandler,
  onMessage?: MessageHandler,
  options: GatewayOptions = {},
): Promise<{ close: () => void }> {
  if (typeof WebSocket === "undefined") {
    ctx.logger.warn(
      "WebSocket is not available in this environment (requires Node.js >= 21). " +
      "Gateway connection disabled — interactions will only work via webhook.",
    );
    return { close: () => {} };
  }

  const gatewayUrl = await getGatewayUrl(ctx, token);
  if (!gatewayUrl) {
    ctx.logger.warn("Could not get Gateway URL, interactions will only work via webhook");
    return { close: () => {} };
  }

  const policy = options.reconnectPolicy ?? new ReconnectPolicy();

  // Session state shared across reconnects (only the current socket may write it).
  let sequence: number | null = null;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let closed = false;
  let permanentlyDown = false;
  let consecutiveFailures = 0;
  let generation = 0;
  let currentSocket: GatewaySocket | null = null;
  // Exactly one reconnect may ever be pending. Multiple pending setTimeout
  // reconnects are how one flapping connection multiplied into parallel loops.
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const listenForMessages = options.listenForMessages ?? Boolean(onMessage);
  const includeMessageContent = options.includeMessageContent ?? listenForMessages;
  const intents =
    GUILD_INTENT |
    (listenForMessages ? GUILD_MESSAGES_INTENT : 0) |
    (includeMessageContent ? MESSAGE_CONTENT_INTENT : 0);

  function isCurrent(sock: GatewaySocket): boolean {
    return !closed && currentSocket === sock;
  }

  function clearHeartbeat(sock: GatewaySocket): void {
    if (sock.heartbeatStartTimer) {
      clearTimeout(sock.heartbeatStartTimer);
      sock.heartbeatStartTimer = null;
    }
    if (sock.heartbeatInterval) {
      clearInterval(sock.heartbeatInterval);
      sock.heartbeatInterval = null;
    }
  }

  function clearConnectTimer(sock: GatewaySocket): void {
    if (sock.connectTimer) {
      clearTimeout(sock.connectTimer);
      sock.connectTimer = null;
    }
  }

  /**
   * Tear a socket down so it can never act again: kill its timers, detach its
   * handlers (a stale socket must not log, reconnect, or touch session state),
   * then close it. Close code 4000 keeps the Discord session resumable; 1000
   * is only used for deliberate shutdown.
   */
  function destroySocket(sock: GatewaySocket, code: number, reason: string): void {
    clearHeartbeat(sock);
    clearConnectTimer(sock);
    sock.ws.onopen = null;
    sock.ws.onmessage = null;
    sock.ws.onerror = null;
    sock.ws.onclose = null;
    try {
      if (
        sock.ws.readyState === WebSocket.OPEN ||
        sock.ws.readyState === WebSocket.CONNECTING
      ) {
        sock.ws.close(code, reason);
      }
    } catch {
      // Already closing/closed — nothing to do.
    }
  }

  function goPermanentlyDown(message: string, details?: Record<string, unknown>): void {
    permanentlyDown = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (currentSocket) {
      destroySocket(currentSocket, 1000, "Gateway permanently disabled");
      currentSocket = null;
    }
    ctx.logger.error(`Gateway permanently disabled: ${message}`, details ?? {});
    options.onPermanentFailure?.(message, details);
  }

  function scheduleReconnect(reason: string, delayMs: number, resumeIntent: boolean): void {
    if (closed || permanentlyDown) return;
    if (reconnectTimer) return; // one pending reconnect at a time — first wins
    ctx.logger.info("Scheduling Gateway reconnect", { reason, delayMs, resume: resumeIntent });
    ctx.metrics.write(METRIC_NAMES.gatewayReconnections, 1).catch(() => {});
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect(resumeIntent && resumeUrl ? resumeUrl : gatewayUrl!, resumeIntent);
    }, delayMs);
  }

  // ws.send throws InvalidStateError ("Sent before connected") if the socket
  // is CONNECTING (0), CLOSING (2), or CLOSED (3) — guard every send.
  // Returns true if the frame was actually sent.
  function safeSend(sock: GatewaySocket, payload: object): boolean {
    if (sock.ws.readyState !== WebSocket.OPEN) return false;
    try {
      sock.ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      ctx.logger.warn("Gateway ws.send failed", {
        readyState: sock.ws.readyState,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function startHeartbeat(sock: GatewaySocket, intervalMs: number): void {
    clearHeartbeat(sock);

    const sendHeartbeat = () => {
      if (!isCurrent(sock)) {
        // Stale timer that outlived its socket — kill it and do nothing else.
        clearHeartbeat(sock);
        return;
      }
      if (sock.awaitingAck) {
        // The previous heartbeat was never acked: the connection is zombied.
        // Close it (non-1000 keeps the session resumable) and let onclose
        // drive exactly one reconnect through the normal backoff path.
        ctx.logger.warn("Heartbeat ACK not received, forcing reconnect", {
          generation: sock.gen,
        });
        try {
          sock.ws.close(4000, "Heartbeat ACK timeout");
        } catch {
          // Already closing — onclose will still fire.
        }
        return;
      }
      if (safeSend(sock, { op: 1, d: sequence })) {
        sock.awaitingAck = true;
      }
    };

    // First heartbeat after `interval * jitter` per the gateway spec, then a
    // steady interval. Both timers are tracked on the socket so a reconnect
    // can always cancel them — the old untracked jitter timeout is what let
    // heartbeat state leak across connections.
    sock.heartbeatStartTimer = setTimeout(() => {
      sock.heartbeatStartTimer = null;
      sendHeartbeat();
      sock.heartbeatInterval = setInterval(sendHeartbeat, intervalMs);
    }, Math.floor(Math.random() * intervalMs));
  }

  function connect(url: string, resumeIntent: boolean): void {
    if (closed || permanentlyDown) return;

    if (currentSocket) {
      // Defensive: no path should get here with a live socket, but if one
      // does, supersede it cleanly instead of leaking a parallel connection.
      destroySocket(currentSocket, 4000, "Superseded by new connection");
      currentSocket = null;
    }

    const resume = resumeIntent && sessionId !== null;
    const gen = ++generation;
    const wsUrl = `${url}/?v=${GATEWAY_VERSION}&encoding=${GATEWAY_ENCODING}`;
    ctx.logger.info("Connecting to Discord Gateway", {
      resume,
      consecutiveFailures,
      generation: gen,
    });

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      ctx.logger.error("Gateway WebSocket construction failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      consecutiveFailures++;
      scheduleReconnect("construct-failed", policy.nextDelay(false), resumeIntent);
      return;
    }

    const sock: GatewaySocket = {
      gen,
      ws,
      connectTimer: null,
      heartbeatStartTimer: null,
      heartbeatInterval: null,
      awaitingAck: false,
      readyAt: null,
    };
    currentSocket = sock;

    // Watchdog: if this socket has not reached READY/RESUMED in time, tear it
    // down and retry. Covers CONNECTING hangs, handshakes that error without a
    // close event, and a HELLO/READY that never arrives.
    sock.connectTimer = setTimeout(() => {
      sock.connectTimer = null;
      if (!isCurrent(sock)) return;
      ctx.logger.warn("Gateway connection not ready within timeout, retrying", {
        generation: gen,
        readyState: ws.readyState,
        timeoutMs: CONNECT_TIMEOUT_MS,
      });
      currentSocket = null;
      destroySocket(sock, 4000, "Connect timeout");
      consecutiveFailures++;
      scheduleReconnect("connect-timeout", policy.nextDelay(false), true);
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (!isCurrent(sock)) return;
      ctx.logger.info("Gateway WebSocket connected", { generation: gen });
    };

    ws.onmessage = async (event) => {
      if (!isCurrent(sock)) return;
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(String(event.data)) as GatewayPayload;
      } catch (error) {
        ctx.logger.warn("Gateway sent unparseable frame", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (payload.s !== null) {
        sequence = payload.s;
      }

      switch (payload.op) {
        case 10: {
          const heartbeatMs = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
          startHeartbeat(sock, heartbeatMs);

          if (resume && sessionId) {
            safeSend(sock, {
              op: 6,
              d: { token: `Bot ${token}`, session_id: sessionId, seq: sequence },
            });
          } else {
            if (!policy.tryConsumeIdentify()) {
              goPermanentlyDown(
                `Discord identify budget exhausted (${IDENTIFY_BUDGET_MAX}/24h) — ` +
                  "refusing to reconnect so the bot token is not reset. " +
                  "Restart the plugin worker after diagnosing the reconnect churn.",
                { identifiesInWindow: policy.identifiesInWindow() },
              );
              return;
            }
            safeSend(sock, {
              op: 2,
              d: {
                token: `Bot ${token}`,
                intents,
                properties: {
                  os: "linux",
                  browser: "paperclip-plugin-discord",
                  device: "paperclip-plugin-discord",
                },
              },
            });
          }
          break;
        }

        case 0: {
          if (payload.t === "READY") {
            const ready = payload.d as ReadyEvent;
            sessionId = ready.session_id;
            resumeUrl = ready.resume_gateway_url;
            sock.readyAt = Date.now();
            clearConnectTimer(sock);
            ctx.logger.info("Gateway ready", { sessionId, generation: gen });
          }

          if (payload.t === "RESUMED") {
            sock.readyAt = Date.now();
            clearConnectTimer(sock);
            ctx.logger.info("Gateway resumed successfully", { generation: gen });
          }

          if (payload.t === "INTERACTION_CREATE") {
            const interaction = payload.d as InteractionCreateEvent;
            try {
              const response = await onInteraction(interaction);
              await respondViaCallback(ctx, interaction.id, interaction.token, response);
            } catch (error) {
              ctx.logger.error("Gateway interaction handler error", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          if (payload.t === "MESSAGE_CREATE" && onMessage) {
            const message = payload.d as MessageCreateEvent;
            try {
              await onMessage(message);
            } catch (error) {
              ctx.logger.error("Gateway message handler error", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          break;
        }

        case 1: {
          safeSend(sock, { op: 1, d: sequence });
          break;
        }

        case 7: {
          ctx.logger.info("Gateway requested reconnect", { generation: gen });
          // Per the gateway spec: close with a non-1000 code and resume. The
          // old socket is torn down BEFORE the new connect so its onclose can
          // never schedule a second, parallel reconnect loop.
          destroySocket(sock, 4000, "Reconnect requested by Discord");
          currentSocket = null;
          scheduleReconnect("server-requested", 500 + Math.floor(Math.random() * 2000), true);
          break;
        }

        case 9: {
          const resumable = payload.d as boolean;
          ctx.logger.info("Invalid session", { resumable, generation: gen });
          if (!resumable) {
            sessionId = null;
            sequence = null;
          }
          destroySocket(sock, 4000, "Invalid session");
          currentSocket = null;
          consecutiveFailures++;
          scheduleReconnect("invalid-session", policy.nextDelay(false), resumable);
          break;
        }

        case 11: {
          sock.awaitingAck = false;
          break;
        }
      }
    };

    ws.onclose = (event) => {
      // The socket's own timers always die with it, current or not.
      clearHeartbeat(sock);
      clearConnectTimer(sock);
      if (!isCurrent(sock)) return; // stale socket: never log, never reconnect
      currentSocket = null;
      ctx.logger.info("Gateway WebSocket closed", {
        code: event.code,
        reason: event.reason,
        generation: gen,
      });
      if (closed) return;

      const fatal = FATAL_CLOSE_CODES[event.code];
      if (fatal) {
        goPermanentlyDown(`Discord closed the gateway with fatal code ${event.code} (${fatal})`, {
          code: event.code,
          reason: event.reason,
        });
        return;
      }

      if (NON_RESUMABLE_CLOSE_CODES.has(event.code)) {
        sessionId = null;
        sequence = null;
      }

      const wasStable =
        sock.readyAt !== null && Date.now() - sock.readyAt >= STABLE_CONNECTION_MS;
      consecutiveFailures = wasStable ? 0 : consecutiveFailures + 1;

      if (event.code === RATE_LIMITED_CLOSE_CODE) {
        policy.penalize();
        ctx.logger.error("Gateway rate limited by Discord (close 4008), cooling down", {
          cooldownMs: RATE_LIMIT_COOLDOWN_MS,
        });
        scheduleReconnect("rate-limited", RATE_LIMIT_COOLDOWN_MS, true);
        return;
      }

      const delay = policy.nextDelay(wasStable);
      if (consecutiveFailures >= REPEATED_FAILURE_LOG_THRESHOLD) {
        ctx.logger.error("Gateway reconnection failing repeatedly, backing off", {
          consecutiveFailures,
          delayMs: delay,
        });
      }
      scheduleReconnect(`close-${event.code}`, delay, true);
    };

    ws.onerror = (event) => {
      if (!isCurrent(sock)) return;
      ctx.logger.warn("Gateway WebSocket error", {
        error: String(event),
        generation: gen,
        readyState: ws.readyState,
      });
      // An error on a socket that is not established is terminal: handshake
      // failures do not reliably emit a close event, and waiting for one left
      // the gateway hung in CONNECTING for 8+ hours on 2026-07-23. Established
      // sockets keep letting onclose drive recovery (it carries the close code).
      if (ws.readyState !== WebSocket.OPEN) {
        currentSocket = null;
        destroySocket(sock, 4000, "Socket error before established");
        consecutiveFailures++;
        scheduleReconnect("connect-error", policy.nextDelay(false), true);
      }
    };
  }

  connect(gatewayUrl, false);

  return {
    close: () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (currentSocket) {
        destroySocket(currentSocket, 1000, "Plugin shutting down");
        currentSocket = null;
      }
    },
  };
}

async function getGatewayUrl(ctx: PluginContext, token: string): Promise<string | null> {
  try {
    const response = await ctx.http.fetch(`${DISCORD_API_BASE}/gateway/bot`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!response.ok) {
      ctx.logger.warn("Failed to get Gateway URL", { status: response.status });
      return null;
    }
    const data = (await response.json()) as { url: string };
    return data.url;
  } catch (error) {
    ctx.logger.error("Gateway URL fetch failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
