import { describe, it, expect, vi, beforeEach } from "vitest";
import { postEmbed, postEmbedWithId, NO_MENTIONS } from "../src/discord-api.js";

// ---------------------------------------------------------------------------
// Outbound messages must never mass-ping.
//
// Message text is assembled from Paperclip-sourced values, and `content`
// (unlike embed bodies) pings. The sharpest case is agentDisplayName, which is
// interpolated OUTSIDE the code fence in thread output — so an agent named
// "@everyone" would ping the server on every message it emits.
// ---------------------------------------------------------------------------

// Discord calls go through the host client (ctx.http.fetch), which is also
// what keeps them inside the host's egress policy — so that is what we mock.
const fetchMock = vi.fn();

function ctx() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    http: { fetch: fetchMock },
  } as any;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true, status: 200, headers: new Headers(),
    json: async () => ({ id: "m1" }), text: async () => "",
  });
});

function sentBody() {
  const [, init] = fetchMock.mock.calls.at(-1)!;
  return JSON.parse((init as any).body);
}

describe("mention suppression", () => {
  it("postEmbed sends an empty allowed_mentions parse list", async () => {
    await postEmbed(ctx(), "tok", "123", { content: "@everyone ship it" });
    expect(sentBody().allowed_mentions).toEqual({ parse: [] });
  });

  it("postEmbedWithId does too", async () => {
    await postEmbedWithId(ctx(), "tok", "123", { content: "@here look" });
    expect(sentBody().allowed_mentions).toEqual({ parse: [] });
  });

  it("a hostile agent display name cannot mass-ping", async () => {
    // agentDisplayName is interpolated outside the code fence in thread output.
    await postEmbed(ctx(), "tok", "123", { content: "**[@everyone]** ```\noutput\n```" });
    const body = sentBody();
    expect(body.content).toContain("@everyone");      // text is preserved…
    expect(body.allowed_mentions.parse).toEqual([]);   // …but it cannot ping
  });

  it("NO_MENTIONS is an empty parse list, not an omission", () => {
    // Omitting allowed_mentions means DEFAULT parsing — i.e. it pings.
    expect(NO_MENTIONS).toEqual({ parse: [] });
  });
});
