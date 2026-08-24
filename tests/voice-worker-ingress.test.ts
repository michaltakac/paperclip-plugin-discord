import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// F1 — how a spoken utterance reaches Paperclip.
//
// Round 1 shipped voice as "post a webhook message and let the inbound router
// pick it up as if it had been typed". It cannot: the router refuses bot
// authors and refuses anything that is not a reply to a message this plugin
// posted, and it does both before any mapping is read. A webhook transcript
// therefore reached nothing at all — and the only ways to make it reachable
// (accepting a webhook_id, or exempting bot authors) would turn every writer to
// that channel into a trusted input source.
//
// So voice does not go through the router. Both sources — the typed-reply
// router and the voice client — call ONE ingress, `ingestInbound`, with an
// already-decided destination. The webhook post is display: the channel sees
// what was heard, and nothing reads it back. A transcript loop is impossible by
// construction rather than by filtering, and the router's trust boundary is
// untouched.
// ---------------------------------------------------------------------------

const { capturedDefinitions } = vi.hoisted(() => ({ capturedDefinitions: [] as any[] }));

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedDefinitions.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

const { gatewayConnects } = vi.hoisted(() => ({ gatewayConnects: [] as any[] }));

vi.mock("../src/gateway.js", () => ({
  connectGateway: vi.fn(async (_ctx: any, token: string, onInteraction: any, onMessage: any, options: any) => {
    const readyHandlers = new Set<() => void>();
    const record: any = {
      token,
      onInteraction,
      onMessage,
      options,
      closed: false,
      fireReady: () => {
        for (const handler of [...readyHandlers]) handler();
      },
      close: () => {
        record.closed = true;
      },
    };
    if (options?.enableVoice) {
      record.voice = {
        sendPayload: () => true,
        onVoiceStateUpdate: () => () => {},
        onVoiceServerUpdate: () => () => {},
        onGatewayReady: (handler: () => void) => {
          readyHandlers.add(handler);
          return () => readyHandlers.delete(handler);
        },
      };
    }
    gatewayConnects.push(record);
    return record;
  }),
}));

const { voiceClients, voiceModule } = vi.hoisted(() => ({
  voiceClients: [] as any[],
  voiceModule: { startRejectsWith: null as Error | null, importFails: null as Error | null },
}));

vi.mock("../src/voice/index.js", () => ({
  createPluginDiscordAdapter: () => () => ({ sendPayload: () => true, destroy: () => {} }),
  VoiceClient: class {
    config: any;
    stopped = false;
    constructor(_ctx: any, config: any) {
      this.config = config;
      voiceClients.push(this);
    }
    async start() {
      if (voiceModule.startRejectsWith) throw voiceModule.startRejectsWith;
    }
    stop() {
      this.stopped = true;
    }
  },
}));

import { _resetRuntimeForTests } from "../src/worker.js";
import { _resetCompanyIdCache } from "../src/company-resolver.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const OTHER_COMPANY = "22222222-2222-2222-2222-222222222222";
const SECRET_ID = "33333333-3333-3333-3333-333333333333";
const VOICE_ISSUE = "44444444-4444-4444-4444-444444444444";
const CHANNEL_ISSUE = "55555555-5555-5555-5555-555555555555";
const TEXT_CHANNEL = "1490608926423646298";

function storedConfig(overrides: Record<string, unknown> = {}) {
  return {
    discordBotTokenRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
    defaultChannelId: "1490608926423646298",
    defaultGuildId: "",
    enableInbound: true,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableCommands: false,
    digestMode: "off",
    ...overrides,
  };
}

function buildHost() {
  const stateStore = new Map<string, unknown>();
  const eventHandlers = new Map<string, any[]>();

  const ctx = {
    config: { get: vi.fn(async (companyId?: string) => (companyId ? storedConfig() : (() => { throw new Error("company context is required"); })())) },
    secrets: { resolve: vi.fn(async () => "discord-bot-token") },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn(async (key: any) => stateStore.get(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`) ?? null),
      set: vi.fn(async (key: any, value: unknown) => {
        stateStore.set(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`, value);
      }),
    },
    metrics: { write: vi.fn() },
    activity: { log: vi.fn() },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: {
      on: vi.fn((name: string, handler: any) => {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
      }),
      emit: vi.fn(),
      subscribe: vi.fn(),
    },
    companies: { list: vi.fn(async () => [{ id: COMPANY_A, name: "A" }]) },
    agents: { list: vi.fn(async () => []), invoke: vi.fn() },
    issues: { list: vi.fn(async () => []), get: vi.fn(async () => null), listComments: vi.fn(async () => []) },
    // Discord REST. A posted embed answers with its message id, which is what
    // makes notify() write the mappings voice later routes by.
    http: {
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: "posted-msg-1" }),
        text: async () => "",
      })),
    },
  } as any;

  return {
    ctx,
    stateStore,
    async deliver(companyId = COMPANY_A, config = storedConfig()) {
      await definition().onConfigChanged(config, { companyId });
    },
    /** Drive a notification through notify(), which is what refreshes the pointers. */
    async notifyIssue(companyId: string, entityId: string) {
      for (const handler of eventHandlers.get("issue.created") ?? []) {
        await handler({
          eventId: `evt-${Math.random().toString(36).slice(2)}`,
          eventType: "issue.created",
          companyId,
          entityId,
          entityType: "issue",
          occurredAt: new Date().toISOString(),
          payload: { title: "a new issue", identifier: "T-1" },
        });
      }
    },
  };
}

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

/** One finished utterance, as the voice client hands it over. */
function utterance(text = "ship the release") {
  return {
    userId: "speaker-7",
    text,
    durationSec: 1.2,
    finalizedAt: new Date().toISOString(),
    threadKey: "voice:guild-1:voice-chan-1:sess-a",
  };
}

function gateway(): any {
  return gatewayConnects[gatewayConnects.length - 1];
}

/** The voice client's config, as the worker handed it over. */
function voiceConfig(): any {
  return voiceClients[voiceClients.length - 1].config;
}

function typedMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-2",
    channel_id: "chan-1",
    content: "a typed reply",
    author: { id: "u1", username: "alice", bot: false },
    message_reference: { message_id: "msg-1", channel_id: "chan-1" },
    ...overrides,
  } as any;
}

let fetchMock: ReturnType<typeof vi.fn>;
let webhookLookup: { ok: boolean; channelId: string };
let commentPostFails = false;

beforeEach(() => {
  _resetRuntimeForTests();
  _resetCompanyIdCache();
  gatewayConnects.length = 0;
  voiceClients.length = 0;
  voiceModule.startRejectsWith = null;
  commentPostFails = false;
  vi.clearAllMocks();

  process.env.DISCORD_VOICE_GUILD_ID = "guild-1";
  process.env.DISCORD_VOICE_CHANNEL_ID = "voice-chan-1";
  process.env.DISCORD_VOICE_WEBHOOK_URL = "https://discord.test/api/webhooks/1/webhook-secret";
  process.env.DEEPGRAM_API_KEY = "deepgram-secret";
  delete process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID;

  webhookLookup = { ok: true, channelId: TEXT_CHANNEL };
  fetchMock = vi.fn(async (url: any) => {
    if (String(url).includes("/api/webhooks/")) {
      // Discord's webhook object carries the channel the URL posts into.
      return {
        ok: webhookLookup.ok,
        status: webhookLookup.ok ? 200 : 404,
        headers: new Headers(),
        json: async () => ({ id: "1", channel_id: webhookLookup.channelId }),
        text: async () => "",
      };
    }
    return {
      ok: !commentPostFails,
      status: commentPostFails ? 404 : 200,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => (commentPostFails ? "issue not found" : ""),
    };
  }) as any;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of [
    "DISCORD_VOICE_GUILD_ID",
    "DISCORD_VOICE_CHANNEL_ID",
    "DISCORD_VOICE_WEBHOOK_URL",
    "DEEPGRAM_API_KEY",
    "DISCORD_VOICE_DEFAULT_ISSUE_ID",
    "DISCORD_VOICE_USERNAME",
  ]) {
    delete process.env[key];
  }
});

/** Every issue-comment POST the plugin made. */
function commentPosts() {
  return fetchMock.mock.calls.filter(([url]: any[]) => String(url).includes("/comments"));
}

describe("inbound ingress — one path for typed replies and voice (F1)", () => {
  it("routes a typed reply exactly as it did before the refactor", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    host.stateStore.set("instance::msg_chan-1_msg-1", {
      entityId: "issue-9",
      entityType: "issue",
      companyId: COMPANY_A,
    });

    await gateway().onMessage(typedMessage());

    expect(commentPosts()).toHaveLength(1);
    const [url, init] = commentPosts()[0];
    expect(String(url)).toContain("/api/issues/issue-9/comments");
    expect(JSON.parse(String(init.body))).toMatchObject({
      body: "a typed reply",
      authorUserId: "discord:alice",
    });
  });

  it("gives voice the ingress directly — the webhook is never an input", async () => {
    process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID = VOICE_ISSUE;
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    await voiceConfig().ingestUtterance({
      userId: "speaker-7",
      text: "ship the release",
      durationSec: 1.2,
      finalizedAt: new Date().toISOString(),
      threadKey: "voice:guild-1:voice-chan-1:sess-a",
    });

    expect(commentPosts()).toHaveLength(1);
    const [url, init] = commentPosts()[0];
    expect(String(url)).toContain(`/api/issues/${VOICE_ISSUE}/comments`);
    expect(JSON.parse(String(init.body))).toMatchObject({
      body: "ship the release",
      authorUserId: "discord:voice:speaker-7",
    });
  });

  it("ingests under the owner company, never one carried in with the utterance", async () => {
    process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID = VOICE_ISSUE;
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A);

    await voiceConfig().ingestUtterance({
      userId: "speaker-7",
      text: "hello",
      durationSec: 1,
      finalizedAt: new Date().toISOString(),
      threadKey: "voice:guild-1:voice-chan-1:sess-a",
      // A caller cannot smuggle a company in: the field is not part of the contract.
      companyId: OTHER_COMPANY,
    } as any);

    expect(commentPosts()).toHaveLength(1);
  });

  it("ingests nothing when no voice destination is configured", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    await voiceConfig().ingestUtterance({
      userId: "speaker-7",
      text: "nowhere to go",
      durationSec: 1,
      finalizedAt: new Date().toISOString(),
      threadKey: "voice:guild-1:voice-chan-1:sess-a",
    });

    expect(commentPosts()).toHaveLength(0);
  });

  it("keeps the escalation-resolved payload the refactor could have changed", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    host.stateStore.set("instance::msg_chan-1_msg-1", {
      entityId: "esc-1",
      entityType: "escalation",
      companyId: COMPANY_A,
    });
    host.stateStore.set(`company:${COMPANY_A}:escalation_esc-1`, {
      escalationId: "esc-1",
      status: "pending",
    });

    await gateway().onMessage(typedMessage());

    // `resolvedBy` on the event is the bare username, as it has always been,
    // while the stored record keeps the attributed `discord:` form.
    expect(host.ctx.events.emit).toHaveBeenCalledWith(
      "escalation-resolved",
      COMPANY_A,
      expect.objectContaining({ resolvedBy: "alice", responseText: "a typed reply" }),
    );
    expect(host.stateStore.get(`company:${COMPANY_A}:escalation_esc-1`)).toMatchObject({
      resolvedBy: "discord:alice",
    });
  });

  it("keeps refusing bot authors, webhook posts included", async () => {
    process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID = VOICE_ISSUE;
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    host.stateStore.set("instance::msg_chan-1_msg-1", {
      entityId: "issue-9",
      entityType: "issue",
      companyId: COMPANY_A,
    });

    // A transcript as Discord delivers it: bot author, webhook_id, no reply ref.
    await gateway().onMessage({
      id: "msg-3",
      channel_id: "chan-1",
      content: "ship the release",
      author: { id: "wh", username: "Voice", bot: true },
      webhook_id: "1",
    } as any);

    // And the same text with a forged reply reference, still bot-authored.
    await gateway().onMessage(
      typedMessage({ author: { id: "wh", username: "Voice", bot: true }, webhook_id: "1" }),
    );

    expect(commentPosts()).toHaveLength(0);
  });

  it("keeps refusing a human message that is not a reply", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    await gateway().onMessage(typedMessage({ message_reference: undefined }));
    expect(commentPosts()).toHaveLength(0);
  });

  it("drops a reply whose mapping is gone", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    await gateway().onMessage(typedMessage());
    expect(commentPosts()).toHaveLength(0);
  });

  it("drops an utterance that transcribed to whitespace", async () => {
    process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID = VOICE_ISSUE;
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    await voiceConfig().ingestUtterance({
      userId: "speaker-7",
      text: "   ",
      durationSec: 1,
      finalizedAt: new Date().toISOString(),
      threadKey: "voice:guild-1:voice-chan-1:sess-a",
    });

    expect(commentPosts()).toHaveLength(0);
  });
});

describe("voice destination — channel target, then configured default", () => {
  it("writes a channel voice target every time it posts a notification", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    await host.notifyIssue(COMPANY_A, CHANNEL_ISSUE);

    expect(host.stateStore.get(`instance::voice_target_${TEXT_CHANNEL}`)).toMatchObject({
      entityId: CHANNEL_ISSUE,
      entityType: "issue",
      companyId: COMPANY_A,
    });
  });

  it("prefers what the transcript's channel is currently about", async () => {
    process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID = VOICE_ISSUE;
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    await host.notifyIssue(COMPANY_A, CHANNEL_ISSUE);

    await voiceConfig().ingestUtterance(utterance());

    expect(commentPosts()).toHaveLength(1);
    expect(String(commentPosts()[0][0])).toContain(`/api/issues/${CHANNEL_ISSUE}/comments`);
  });

  it("moves with the channel — last notification wins", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    await host.notifyIssue(COMPANY_A, CHANNEL_ISSUE);
    await host.notifyIssue(COMPANY_A, "issue-later");
    await voiceConfig().ingestUtterance(utterance());

    expect(String(commentPosts()[0][0])).toContain("/api/issues/issue-later/comments");
  });

  it("falls back to the configured default when the channel has no target", async () => {
    process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID = VOICE_ISSUE;
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    await voiceConfig().ingestUtterance(utterance());

    expect(String(commentPosts()[0][0])).toContain(`/api/issues/${VOICE_ISSUE}/comments`);
  });

  it("ignores a channel target left by a previous owner of this install", async () => {
    // Ownership can move (claimOwnership's equal-config rule). A pointer written
    // under the old owner must never route a transcript under the new one.
    process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID = VOICE_ISSUE;
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    host.stateStore.set(`instance::voice_target_${TEXT_CHANNEL}`, {
      entityId: CHANNEL_ISSUE,
      entityType: "issue",
      companyId: OTHER_COMPANY,
    });

    await voiceConfig().ingestUtterance(utterance());

    expect(commentPosts()).toHaveLength(1);
    expect(String(commentPosts()[0][0])).toContain(`/api/issues/${VOICE_ISSUE}/comments`);
  });

  it("ingests nothing when the only channel target belongs to another company", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    host.stateStore.set(`instance::voice_target_${TEXT_CHANNEL}`, {
      entityId: CHANNEL_ISSUE,
      entityType: "issue",
      companyId: OTHER_COMPANY,
    });

    await voiceConfig().ingestUtterance(utterance());

    expect(commentPosts()).toHaveLength(0);
  });

  it("uses the configured default when the webhook's channel cannot be resolved", async () => {
    process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID = VOICE_ISSUE;
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    await host.notifyIssue(COMPANY_A, CHANNEL_ISSUE);

    webhookLookup.ok = false;
    await voiceConfig().ingestUtterance(utterance());

    expect(String(commentPosts()[0][0])).toContain(`/api/issues/${VOICE_ISSUE}/comments`);
  });

  it("never puts the webhook URL in the log when its lookup fails", async () => {
    webhookLookup.ok = false;
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    await voiceConfig().ingestUtterance(utterance());

    const said = JSON.stringify([
      host.ctx.logger.warn.mock.calls,
      host.ctx.logger.error.mock.calls,
      host.ctx.logger.info.mock.calls,
    ]);
    expect(said).not.toContain("webhook-secret");
  });

  it("reports display-only health when nothing is configured, and clears it once routed", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    await voiceConfig().ingestUtterance(utterance());
    let health = await definition().onHealth();
    expect(health.status).toBe("degraded");
    expect(health.details).toMatchObject({ issue: "discord-voice-display-only" });
    expect(health.message).toContain("display-only");
    expect(health.message).not.toContain("webhook-secret");

    process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID = VOICE_ISSUE;
    await voiceConfig().ingestUtterance(utterance());
    health = await definition().onHealth();
    expect(health.status).toBe("ok");
  });

  it("survives a destination Paperclip rejects, and says so through health", async () => {
    process.env.DISCORD_VOICE_DEFAULT_ISSUE_ID = VOICE_ISSUE;
    commentPostFails = true;
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    await expect(voiceConfig().ingestUtterance(utterance())).resolves.toBeUndefined();

    const health = await definition().onHealth();
    expect(health.status).toBe("degraded");
    expect(health.details).toMatchObject({ issue: "discord-voice-display-only" });
    expect(health.message).toContain("rejected");
  });

  it("leaves the typed-reply path on its own message mapping", async () => {
    // A channel target must not hijack a reply that has a mapping of its own.
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();
    await host.notifyIssue(COMPANY_A, CHANNEL_ISSUE);

    host.stateStore.set("instance::msg_chan-1_msg-1", {
      entityId: "issue-9",
      entityType: "issue",
      companyId: COMPANY_A,
    });
    await gateway().onMessage(typedMessage());

    expect(String(commentPosts()[0][0])).toContain("/api/issues/issue-9/comments");
  });
});

describe("voice lifecycle in the worker (F2, F5)", () => {
  it("asks the gateway for the voice intent and hands voice its readiness hook", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    expect(gateway().options.enableVoice).toBe(true);
    expect(typeof voiceConfig().onGatewayReady).toBe("function");

    // The hook the worker passed is really the gateway's.
    const seen = vi.fn();
    voiceConfig().onGatewayReady(seen);
    gateway().fireReady();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("does not ask for the voice intent when voice is not configured", async () => {
    delete process.env.DEEPGRAM_API_KEY;
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    expect(gateway().options.enableVoice).toBe(false);
    expect(voiceClients).toHaveLength(0);
    expect(await definition().onHealth()).toMatchObject({ status: "ok" });
  });

  it("degrades health when the voice client cannot start, without naming a secret", async () => {
    voiceModule.startRejectsWith = new Error("joining wss://voice.test failed for deepgram-secret");
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    const health = await definition().onHealth();
    expect(health.status).toBe("degraded");
    expect(health.details).toMatchObject({ issue: "discord-voice-unavailable" });
    expect(health.message).not.toContain("deepgram-secret");
    expect(health.message).not.toContain("webhook-secret");
  });

  it("stops a client that failed after construction, so nothing is left subscribed", async () => {
    voiceModule.startRejectsWith = new Error("readiness timed out");
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    expect(voiceClients[0].stopped).toBe(true);
  });

  it("reports missing optional peers as unavailable voice, with the install command", async () => {
    const err = new Error("Cannot find package '@discordjs/voice'") as NodeJS.ErrnoException;
    err.code = "ERR_MODULE_NOT_FOUND";
    voiceModule.startRejectsWith = err;

    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    const health = await definition().onHealth();
    expect(health.status).toBe("degraded");
    expect(health.details).toMatchObject({ issue: "discord-voice-unavailable" });
    expect(host.ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("npm install @discordjs/voice"),
      expect.anything(),
    );
  });

  it("clears the voice degradation once voice reports itself available", async () => {
    voiceModule.startRejectsWith = null;
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    voiceConfig().onAvailabilityChange(false, "waiting for the Discord gateway to be ready");
    expect((await definition().onHealth()).status).toBe("degraded");

    voiceConfig().onAvailabilityChange(true);
    expect((await definition().onHealth()).status).toBe("ok");
  });

  it("takes voice down with the plugin", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver();

    const stopping = host.ctx.events.on.mock.calls.find(([name]: any[]) => name === "plugin.stopping");
    await stopping[1]();

    expect(voiceClients[0].stopped).toBe(true);
    expect(gateway().closed).toBe(true);
  });
});
