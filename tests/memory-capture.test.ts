import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Memory capture: a reaction files a Discord message as a Paperclip issue.
//
// The properties that matter are about who can trigger it and what reaches the
// agent, not that an issue gets created:
//   - it fails closed: the reactor is on the admin list, or has linked a
//     Paperclip account that is a non-viewer member of the company. Nobody
//     else, even on a guild with no admin list (the one place this plugin
//     does NOT fall open);
//   - a bot's message is never captured;
//   - one message yields one issue, however many people react;
//   - the stored text carries who said it, when, and a link back.
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
  type CaptureSettings,
  type ReactionAddEvent,
  DEFAULT_CAPTURE_INSTRUCTIONS,
  _resetMemoryCapture,
  buildCaptureIssue,
  buildCaptureRecord,
  captureTitle,
  handleCaptureReaction,
  matchesCaptureEmoji,
  renderMentions,
} from "../src/memory-capture.js";
import { saveLink } from "../src/identity.js";
import { _resetSafeState } from "../src/safe-state.js";

const GUILD = "1521479182117376050";
const CHANNEL = "1521552916798771400";
const MESSAGE = "1554868165031370813";
const PARENT = "1554800000000000000";
const MICHAL = "100000000000000001";
const MARTIN = "100000000000000002";

const martinMessage = {
  id: MESSAGE,
  content:
    "@everyone aby ste boli up-to-date, HS-Plus/ADMAX/Opre dočasne presunuli rozhodovanie o Agentic AI nasadení na október/november, kvôli časovej vyťaženosti, uvidíme ako sa finálne vyjadria. Auguste Cryogenics ako som písal vyššie.",
  author: { id: MARTIN, username: "Martin" },
  timestamp: "2026-09-30T14:50:00.000000+00:00",
  mentions: [],
  attachments: [],
  message_reference: { message_id: PARENT, channel_id: CHANNEL, guild_id: GUILD },
  referenced_message: {
    id: PARENT,
    content: `https://github.com/michaltakac/agentic-consulting/pull/139 <@${MARTIN}> please review`,
    author: { id: MICHAL, username: "michaltakac" },
    timestamp: "2026-09-29T09:00:00.000000+00:00",
    mentions: [{ id: MARTIN, username: "Martin" }],
  },
};

function json(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Host stand-in: in-memory state, and Discord GETs answered from `discord`. */
function fakeCtx(discord: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>();
  const httpFetch = vi.fn(async (url: string) => {
    for (const [suffix, body] of Object.entries(discord)) {
      if (url.endsWith(suffix)) return json(body);
    }
    return json({ message: "Unknown" }, 404);
  });
  return {
    store,
    httpFetch,
    state: {
      get: vi.fn(async ({ stateKey }: any) => store.get(stateKey) ?? null),
      set: vi.fn(async ({ stateKey }: any, value: unknown) => {
        store.set(stateKey, value);
      }),
    },
    http: { fetch: httpFetch },
    metrics: { write: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as any;
}

function settings(overrides: Partial<CaptureSettings> = {}): CaptureSettings {
  return {
    token: "bot-token",
    companyId: "company-1",
    baseUrl: "http://127.0.0.1:3102",
    paperclipBoardApiKey: "board-key",
    guildId: GUILD,
    emoji: "🧠",
    channelIds: [],
    projectId: "project-knowledge",
    assigneeAgentId: null,
    instructions: DEFAULT_CAPTURE_INSTRUCTIONS,
    adminUserIds: [],
    adminRoleIds: [],
    ...overrides,
  };
}

function reaction(overrides: Partial<ReactionAddEvent> = {}): ReactionAddEvent {
  return {
    user_id: MICHAL,
    channel_id: CHANNEL,
    message_id: MESSAGE,
    guild_id: GUILD,
    member: { roles: [], user: { id: MICHAL, username: "michaltakac" } },
    emoji: { id: null, name: "🧠" },
    ...overrides,
  };
}

const discordFixture = {
  [`/channels/${CHANNEL}/messages/${MESSAGE}`]: martinMessage,
  [`/channels/${CHANNEL}`]: { name: "general" },
};

async function linked(ctx: any, discordUserId = MICHAL, paperclipUserId = "user-michal") {
  await saveLink(ctx, {
    paperclipUserId,
    discordUserId,
    discordUsername: "michaltakac",
    linkedAt: "2026-09-04T00:00:00Z",
  });
}

const MEMBERS = [
  { principalId: "user-michal", status: "active", membershipRole: "owner" },
  { principalId: "user-readonly", status: "active", membershipRole: "viewer" },
  { principalId: "user-gone", status: "suspended", membershipRole: "owner" },
];

/** Paperclip lists the members and accepts the issue; Discord accepts the bot's ✅. */
function acceptEverything() {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith("/members")) return json({ members: MEMBERS });
    if (String(url).endsWith("/issues")) return json({ id: "issue-uuid", identifier: "AGE-999" });
    return json({}, 204);
  });
}

function issueRequests() {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/issues"));
}

/** Channel posts go through the host client, unlike the ✅ reaction. */
function channelPosts(ctx: any) {
  return ctx.httpFetch.mock.calls.filter(([url, init]: any[]) => init?.method === "POST" && String(url).endsWith("/messages"));
}

beforeEach(() => {
  fetchMock.mockReset();
  _resetMemoryCapture();
  _resetSafeState();
});

describe("matchesCaptureEmoji", () => {
  it("matches a unicode emoji, ignoring the variation selector", () => {
    expect(matchesCaptureEmoji({ id: null, name: "🧠" }, "🧠")).toBe(true);
    expect(matchesCaptureEmoji({ id: null, name: "❤️" }, "❤")).toBe(true);
    expect(matchesCaptureEmoji({ id: null, name: "📌" }, "🧠")).toBe(false);
  });

  it("matches a custom emoji by id, name, or <:name:id>", () => {
    const custom = { id: "42", name: "brain" };
    expect(matchesCaptureEmoji(custom, "42")).toBe(true);
    expect(matchesCaptureEmoji(custom, "brain")).toBe(true);
    expect(matchesCaptureEmoji(custom, "<:brain:42>")).toBe(true);
    expect(matchesCaptureEmoji(custom, "<:brain:43>")).toBe(false);
  });

  it("falls back to the default when the setting is blank", () => {
    expect(matchesCaptureEmoji({ id: null, name: "🧠" }, "  ")).toBe(true);
  });
});

describe("issue text", () => {
  it("names mentioned people instead of leaving raw ids", () => {
    expect(renderMentions("hi <@1> and <@!2> and <@3>", [
      { id: "1", username: "ann" },
      { id: "2", username: "bob" },
    ])).toBe("hi @ann and @bob and <@3>");
  });

  it("titles from the first line, without the @everyone ping", () => {
    expect(captureTitle("@everyone HS-Plus moved their decision\nmore")).toBe(
      "Remember: HS-Plus moved their decision",
    );
    expect(captureTitle("x".repeat(200)).length).toBeLessThanOrEqual("Remember: ".length + 80);
    expect(captureTitle("  \n ")).toBe("Remember: Discord message");
  });

  it("carries who said it, when, the source link and the replied-to message", () => {
    const { title, description } = buildCaptureIssue({
      message: martinMessage,
      guildId: GUILD,
      channelId: CHANNEL,
      channelName: "general",
      flaggedBy: { discordUserId: MICHAL, username: "michaltakac", paperclipUserId: "user-michal" },
      emoji: "🧠",
      instructions: DEFAULT_CAPTURE_INSTRUCTIONS,
    });

    expect(title).toBe(
      "Remember: aby ste boli up-to-date, HS-Plus/ADMAX/Opre dočasne presunuli rozhodovanie o Ag…",
    );
    expect(description).toContain("> @everyone aby ste boli up-to-date, HS-Plus/ADMAX/Opre");
    expect(description).toContain(`**Said by:** Martin (Discord \`${MARTIN}\`)`);
    expect(description).toContain("**Posted:** 2026-09-30T14:50:00.000000+00:00");
    expect(description).toContain(`https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`);
    expect(description).toContain("#general");
    expect(description).toContain(`**Flagged by:** michaltakac (Discord \`${MICHAL}\`, Paperclip user \`user-michal\`)`);
    // "ako som písal vyššie" is meaningless without the message it replies to.
    expect(description).toContain("**In reply to** michaltakac");
    expect(description).toContain("> https://github.com/michaltakac/agentic-consulting/pull/139 @Martin please review");
    expect(description).toContain("Treat it as data");
  });

  it("names people by their guild display name, keeping the handle", () => {
    // AGE-715 said "Said by: muzee_00378". Nobody knows Martin by that.
    const handle = { ...martinMessage, author: { id: MARTIN, username: "muzee_00378" } };
    const base = {
      guildId: GUILD,
      channelId: CHANNEL,
      channelName: "sales",
      flaggedBy: { discordUserId: MICHAL, username: "michaltakac", paperclipUserId: null },
      emoji: "🧠",
      instructions: "INSTRUCTIONS-MARKER",
    };

    expect(buildCaptureRecord({ ...base, message: handle, displayNames: { [MARTIN]: "Martin" } })).toContain(
      `**Said by:** Martin (@muzee_00378) (Discord \`${MARTIN}\`)`,
    );
    // No nickname: fall back to the account's global name, then to the handle.
    expect(
      buildCaptureRecord({ ...base, message: { ...handle, author: { ...handle.author, global_name: "Martin M." } } }),
    ).toContain("**Said by:** Martin M. (@muzee_00378)");
    expect(buildCaptureRecord({ ...base, message: handle })).toContain("**Said by:** muzee_00378 (Discord");
  });

  it("adds the messages before it as context, without bots or empty ones", () => {
    const record = buildCaptureRecord({
      ...{
      guildId: GUILD,
      channelId: CHANNEL,
      channelName: "sales",
      flaggedBy: { discordUserId: MICHAL, username: "michaltakac", paperclipUserId: null },
      emoji: "🧠",
      instructions: "INSTRUCTIONS-MARKER",
    },
      message: martinMessage,
      context: [
        { id: "1", content: "Auguste Cryogenics: stretnutie\nbude 14.10.", author: { id: MARTIN, username: "Martin" }, timestamp: "2026-09-30T14:40:00Z" },
        { id: "2", content: "Issue done", author: { id: "999", username: "Ordi", bot: true }, timestamp: "2026-09-30T14:41:00Z" },
        { id: "3", content: "  ", author: { id: MICHAL, username: "michaltakac" }, timestamp: "2026-09-30T14:42:00Z" },
      ],
    });

    expect(record).toContain("**Earlier in the channel** (context only, oldest first):");
    expect(record).toContain("> Martin, 2026-09-30T14:40:00Z: Auguste Cryogenics: stretnutie bude 14.10.");
    expect(record).not.toContain("Issue done");
    expect(record).not.toContain("michaltakac, 2026-09-30T14:42:00Z");
  });

  it("keeps the instructions out of the record that is posted as a comment", () => {
    const input = { ...{
      guildId: GUILD,
      channelId: CHANNEL,
      channelName: "sales",
      flaggedBy: { discordUserId: MICHAL, username: "michaltakac", paperclipUserId: null },
      emoji: "🧠",
      instructions: "INSTRUCTIONS-MARKER",
    }, message: martinMessage };
    expect(buildCaptureRecord(input)).not.toContain("INSTRUCTIONS-MARKER");
    expect(buildCaptureIssue(input).description).toContain("INSTRUCTIONS-MARKER");
    expect(buildCaptureIssue(input).description.startsWith(buildCaptureRecord(input))).toBe(true);
  });

  it("lists attachment names but not their expiring CDN links", () => {
    const { description } = buildCaptureIssue({
      message: { ...martinMessage, attachments: [{ id: "a", filename: "quote.pdf" }] },
      guildId: GUILD,
      channelId: CHANNEL,
      channelName: null,
      flaggedBy: { discordUserId: MICHAL, username: "michaltakac", paperclipUserId: "user-michal" },
      emoji: "🧠",
      instructions: "do it",
    });
    expect(description).toContain("quote.pdf");
    expect(description).not.toContain("cdn.discordapp.com");
  });
});

describe("handleCaptureReaction", () => {
  it("files the message as an issue and acknowledges with a reaction", async () => {
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    acceptEverything();

    const outcome = await handleCaptureReaction(ctx, settings(), reaction());

    expect(outcome).toEqual({ status: "captured", issueId: "issue-uuid", identifier: "AGE-999" });
    const [[url, init]] = issueRequests();
    expect(url).toBe("http://127.0.0.1:3102/api/companies/company-1/issues");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer board-key");
    const body = JSON.parse(init.body);
    expect(body.status).toBe("todo");
    expect(body.projectId).toBe("project-knowledge");
    expect(body).not.toHaveProperty("assigneeAgentId"); // unassigned wakes no agent
    expect(body.description).toContain("HS-Plus/ADMAX/Opre");

    const ack = fetchMock.mock.calls.find(([u]) => String(u).includes("/reactions/"));
    expect(ack?.[0]).toBe(
      `https://discord.com/api/v10/channels/${CHANNEL}/messages/${MESSAGE}/reactions/${encodeURIComponent("✅")}/@me`,
    );
    expect(ack?.[1].method).toBe("PUT");
  });

  it("posts the record as the issue's first comment, so comment-synced memory has the fact", async () => {
    // Honcho syncs comments, not descriptions: AGE-715 reached it as an empty session.
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    acceptEverything();

    await handleCaptureReaction(ctx, settings(), reaction());

    const comment = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/comments"));
    expect(comment?.[0]).toBe("http://127.0.0.1:3102/api/issues/issue-uuid/comments");
    expect(new Headers(comment?.[1].headers).get("Authorization")).toBe("Bearer board-key");
    const body = JSON.parse(comment?.[1].body).body;
    expect(body).toContain("> @everyone aby ste boli up-to-date");
    expect(body).toContain(`https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`);
    expect(body).not.toContain("What to do");
  });

  it("still counts as captured when the comment fails, and does not retry the issue", async () => {
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/members")) return json({ members: MEMBERS });
      if (String(url).endsWith("/issues")) return json({ id: "issue-uuid", identifier: "AGE-999" });
      if (String(url).endsWith("/comments")) return json({ error: "nope board-key" }, 500);
      return json({}, 204);
    });

    const outcome = await handleCaptureReaction(ctx, settings(), reaction());
    const again = await handleCaptureReaction(ctx, settings(), reaction());

    expect(outcome.status).toBe("captured");
    expect(again.status).toBe("duplicate");
    expect(issueRequests()).toHaveLength(1);
    expect(JSON.stringify(ctx.logger.warn.mock.calls)).not.toContain("board-key");
  });

  it("looks up the author's display name and the messages before it", async () => {
    const ctx = fakeCtx({
      ...discordFixture,
      [`/guilds/${GUILD}/members/${MARTIN}`]: { nick: "Martin M.", user: { global_name: "Martin" } },
      [`/messages?before=${MESSAGE}&limit=5`]: [
        // Discord returns newest first.
        { id: "11", content: "druhá", author: { id: MARTIN, username: "Martin" }, timestamp: "2026-09-30T14:45:00Z" },
        { id: "10", content: "prvá", author: { id: MARTIN, username: "Martin" }, timestamp: "2026-09-30T14:40:00Z" },
        { ...martinMessage.referenced_message },
      ],
    });
    await linked(ctx);
    acceptEverything();

    await handleCaptureReaction(ctx, settings(), reaction());

    const description: string = JSON.parse(issueRequests()[0][1].body).description;
    expect(description).toContain("**Said by:** Martin M. (@Martin)");
    expect(description.indexOf("prvá")).toBeLessThan(description.indexOf("druhá"));
    // The replied-to message is quoted once, in full, not again as context.
    expect(description.split("pull/139").length - 1).toBe(1);
  });

  it("says so in the log when the channel list turns a capture away", async () => {
    // A project id was once pasted into this setting; every reaction vanished.
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    acceptEverything();

    await handleCaptureReaction(ctx, settings({ channelIds: ["9ecc1940-not-a-channel"] }), reaction());

    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Memory capture ignored: channel is not in memoryCaptureChannelIds",
      { channelId: CHANNEL, allowedChannelIds: ["9ecc1940-not-a-channel"] },
    );
  });

  it("assigns only after the comment, so the agent is woken once", async () => {
    // A human comment on an open issue wakes its assignee. Assigning at creation
    // ran the COO twice per capture, the second run failing on a checkout 409.
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    acceptEverything();

    await handleCaptureReaction(ctx, settings({ assigneeAgentId: "agent-coo" }), reaction());

    expect(JSON.parse(issueRequests()[0][1].body)).not.toHaveProperty("assigneeAgentId");
    const paperclip = fetchMock.mock.calls
      .filter(([u]) => String(u).startsWith("http://127.0.0.1:3102/api/issues"))
      .map(([u, init]) => `${init.method} ${String(u).replace("http://127.0.0.1:3102", "")}`);
    expect(paperclip).toEqual(["POST /api/issues/issue-uuid/comments", "PATCH /api/issues/issue-uuid"]);
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(patch?.[1].body)).toEqual({ assigneeAgentId: "agent-coo" });
  });

  it("sends no assignment when no assignee is configured", async () => {
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    acceptEverything();

    await handleCaptureReaction(ctx, settings(), reaction());

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("keeps the capture when the assignment fails, and says so", async () => {
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (String(url).endsWith("/members")) return json({ members: MEMBERS });
      if (String(url).endsWith("/issues")) return json({ id: "issue-uuid", identifier: "AGE-999" });
      if (init?.method === "PATCH") return json({ error: "no such agent" }, 422);
      return json({}, 204);
    });

    const outcome = await handleCaptureReaction(ctx, settings({ assigneeAgentId: "agent-gone" }), reaction());

    expect(outcome.status).toBe("captured");
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Memory capture could not assign the issue; it stays unassigned",
      expect.objectContaining({ issueId: "issue-uuid", assigneeAgentId: "agent-gone" }),
    );
  });

  it("makes one issue per message, however many reactions arrive", async () => {
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    acceptEverything();

    const first = await handleCaptureReaction(ctx, settings(), reaction());
    const second = await handleCaptureReaction(ctx, settings(), reaction());

    expect(first.status).toBe("captured");
    expect(second).toEqual({ status: "duplicate", issueId: "issue-uuid", identifier: "AGE-999" });
    expect(issueRequests()).toHaveLength(1);
  });

  it("makes one issue when two reactions race", async () => {
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    acceptEverything();

    const outcomes = await Promise.all([
      handleCaptureReaction(ctx, settings(), reaction()),
      handleCaptureReaction(ctx, settings(), reaction()),
    ]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(["captured", "ignored"]);
    expect(issueRequests()).toHaveLength(1);
  });

  it("refuses a reactor who has not linked a Paperclip account, even with no admin list", async () => {
    // The privileged slash commands fall open when no admin list is set. This
    // must not: it writes to what agents will later believe.
    const ctx = fakeCtx(discordFixture);
    acceptEverything();

    const outcome = await handleCaptureReaction(ctx, settings(), reaction());

    expect(outcome).toEqual({ status: "refused", reason: "reactor-not-linked" });
    expect(fetchMock).not.toHaveBeenCalled();
    // Not even a message read: the only Discord call is the how-to-link hint.
    expect(ctx.httpFetch).toHaveBeenCalledTimes(1);
    expect(channelPosts(ctx)).toHaveLength(1);
  });

  it("tells a refused reactor how to link, once a day, without pinging anyone", async () => {
    const ctx = fakeCtx(discordFixture);
    acceptEverything();

    await handleCaptureReaction(ctx, settings(), reaction());
    await handleCaptureReaction(ctx, settings(), reaction());

    const posts = channelPosts(ctx);
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`);
    const body = JSON.parse(posts[0][1].body);
    expect(body.content).toContain("/clip link");
    expect(body.content).toContain("michaltakac");
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("accepts a linked company member who is not on the admin list", async () => {
    // How the other cofounders get access without anyone collecting Discord ids.
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    acceptEverything();

    const outcome = await handleCaptureReaction(ctx, settings({ adminUserIds: ["someone-else"] }), reaction());

    expect(outcome.status).toBe("captured");
    expect(channelPosts(ctx)).toHaveLength(0);
  });

  it.each([
    ["a read-only viewer", "user-readonly"],
    ["a suspended member", "user-gone"],
    ["someone outside the company", "user-stranger"],
  ])("refuses a linked account that is %s", async (_label, paperclipUserId) => {
    const ctx = fakeCtx(discordFixture);
    await linked(ctx, MICHAL, paperclipUserId);
    acceptEverything();

    const outcome = await handleCaptureReaction(ctx, settings(), reaction());

    expect(outcome).toEqual({ status: "refused", reason: "reactor-not-a-company-member" });
    expect(issueRequests()).toHaveLength(0);
  });

  it("refuses a linked reactor when the membership lookup fails", async () => {
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    fetchMock.mockImplementation(async () => json({ error: "Board access required" }, 403));

    const outcome = await handleCaptureReaction(ctx, settings(), reaction());

    expect(outcome).toEqual({ status: "refused", reason: "reactor-not-a-company-member" });
  });

  it("accepts an admin-listed reactor who never linked, and says so in the issue", async () => {
    // The live Ordillect state on 2026-10-01: one admin user id, not linked.
    const ctx = fakeCtx(discordFixture);
    acceptEverything();

    const outcome = await handleCaptureReaction(ctx, settings({ adminUserIds: [MICHAL] }), reaction());

    expect(outcome.status).toBe("captured");
    expect(JSON.parse(issueRequests()[0][1].body).description).toContain("no linked Paperclip account");
  });

  it("accepts a reactor who holds a configured admin role", async () => {
    const ctx = fakeCtx(discordFixture);
    acceptEverything();

    const outcome = await handleCaptureReaction(
      ctx,
      settings({ adminRoleIds: ["role-founder"] }),
      reaction({ member: { roles: ["role-founder"], user: { id: MICHAL, username: "michaltakac" } } }),
    );

    expect(outcome.status).toBe("captured");
  });

  it("never captures a bot's message", async () => {
    const ctx = fakeCtx({
      ...discordFixture,
      [`/channels/${CHANNEL}/messages/${MESSAGE}`]: {
        ...martinMessage,
        author: { id: "999", username: "Ordi", bot: true },
      },
    });
    await linked(ctx);
    acceptEverything();

    const outcome = await handleCaptureReaction(ctx, settings(), reaction());

    expect(outcome).toEqual({ status: "refused", reason: "author-is-a-bot" });
    expect(issueRequests()).toHaveLength(0);
  });

  it("ignores other emoji, other guilds, DMs, disallowed channels and bot reactions before any I/O", async () => {
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    acceptEverything();
    const stateReads = ctx.state.get.mock.calls.length;

    const cases: Array<[ReactionAddEvent, CaptureSettings]> = [
      [reaction({ emoji: { id: null, name: "👍" } }), settings()],
      [reaction({ guild_id: "another-guild" }), settings()],
      [reaction({ guild_id: undefined }), settings()],
      [reaction(), settings({ channelIds: ["some-other-channel"] })],
      [reaction({ member: { user: { id: "999", username: "Ordi", bot: true } } }), settings()],
    ];
    for (const [event, cfg] of cases) {
      expect((await handleCaptureReaction(ctx, cfg, event)).status).toBe("ignored");
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.httpFetch).not.toHaveBeenCalled();
    expect(ctx.state.get.mock.calls.length).toBe(stateReads);
  });

  it("does not file an empty quote when Discord withholds the content", async () => {
    const ctx = fakeCtx({
      ...discordFixture,
      [`/channels/${CHANNEL}/messages/${MESSAGE}`]: { ...martinMessage, content: "" },
    });
    await linked(ctx);
    acceptEverything();

    const outcome = await handleCaptureReaction(ctx, settings(), reaction());

    expect(outcome).toEqual({ status: "failed", reason: "message-has-no-readable-content" });
    expect(issueRequests()).toHaveLength(0);
  });

  it("reports failure, keeps the board key out of the log, and can be retried", async () => {
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/members")) return json({ members: MEMBERS });
      throw new Error("connect ECONNREFUSED with board-key in it");
    });

    const failed = await handleCaptureReaction(ctx, settings(), reaction());

    expect(failed).toEqual({ status: "failed", reason: "issue-create-failed" });
    expect(JSON.stringify(ctx.logger.error.mock.calls)).not.toContain("board-key");

    acceptEverything();
    expect((await handleCaptureReaction(ctx, settings(), reaction())).status).toBe("captured");
  });

  it("still counts as captured when the acknowledging reaction fails", async () => {
    const ctx = fakeCtx(discordFixture);
    await linked(ctx);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/members")) return json({ members: MEMBERS });
      if (String(url).endsWith("/issues")) return json({ id: "issue-uuid", identifier: "AGE-999" });
      return json({ message: "Missing Permissions" }, 403);
    });

    const outcome = await handleCaptureReaction(ctx, settings(), reaction());

    expect(outcome.status).toBe("captured");
  });
});
