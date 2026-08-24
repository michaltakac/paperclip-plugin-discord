import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebhookTextChannelRelay } from "../src/voice/text-channel-relay.js";

const FAKE_URL = "https://discord.example/api/webhooks/123/abc";

function lastBody(): any {
  const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
  const [, opts] = calls[calls.length - 1] as [string, RequestInit];
  return JSON.parse(opts.body as string);
}

describe("WebhookTextChannelRelay", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to the webhook URL with content and the default username", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await relay.postTranscript("hello there", { durationSec: 1.2 });

    expect(global.fetch).toHaveBeenCalledOnce();
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const [url] = calls[0] as [string, RequestInit];
    expect(url).toBe(FAKE_URL);
    const body = lastBody();
    expect(body.content).toBe("hello there");
    expect(body.username).toBe("Voice");
  });

  it("retries once on 5xx then succeeds", async () => {
    const mock = global.fetch as ReturnType<typeof vi.fn>;
    mock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await relay.postTranscript("retry test", { durationSec: 1.0 });

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 4xx auth failure", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("invalid webhook token", { status: 401 }),
    );

    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await expect(
      relay.postTranscript("auth fail", { durationSec: 0.5 }),
    ).rejects.toThrow(/401/);

    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it("skips empty transcripts (silence detected, no text)", async () => {
    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await relay.postTranscript("", { durationSec: 0.3 });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("trims whitespace-only transcripts to empty (also skipped)", async () => {
    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await relay.postTranscript("   \n  ", { durationSec: 0.5 });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("uses custom username if configured", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const relay = new WebhookTextChannelRelay({
      webhookUrl: FAKE_URL,
      username: "Custom Name",
    });
    await relay.postTranscript("hi", { durationSec: 0.5 });

    expect(lastBody().username).toBe("Custom Name");
  });
});

// ---------------------------------------------------------------------------
// Mention safety. A transcript is machine-generated from whatever someone said
// out loud, so it is fully attacker-influenced text arriving on a webhook that
// posts into a channel. Without allowed_mentions, saying "at everyone" is
// enough to mass-ping the server.
//
// The control is Discord's own allow-list, not string filtering: the literal
// text is preserved, and nothing in it can resolve to a ping.
// ---------------------------------------------------------------------------
describe("WebhookTextChannelRelay — mention safety", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("always sends allowed_mentions with an empty parse list", async () => {
    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await relay.postTranscript("perfectly ordinary sentence", { durationSec: 1 });

    expect(lastBody().allowed_mentions).toEqual({ parse: [] });
  });

  it.each([
    ["@everyone", "@everyone ship it now"],
    ["@here", "hey @here can someone look"],
    ["role mention", "ping <@&123456789012345678> about this"],
    ["user mention", "ask <@987654321098765432> to review"],
    ["mixed", "<@&1> @everyone @here <@2> all at once"],
  ])("neutralises %s without rewriting the transcript", async (_label, transcript) => {
    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await relay.postTranscript(transcript, { durationSec: 2 });

    const body = lastBody();
    // Text is preserved verbatim — the operator still sees what was said.
    expect(body.content).toBe(transcript);
    // But Discord is told to resolve no mentions at all.
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("keeps allowed_mentions on the 5xx retry attempt", async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await relay.postTranscript("@everyone retry", { durationSec: 1 });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [, opts] of calls as Array<[string, RequestInit]>) {
      expect(JSON.parse(opts.body as string).allowed_mentions).toEqual({ parse: [] });
    }
  });

  it("skips the 5xx retry when the caller has lost standing", async () => {
    // Unit-level twin of the client regression: the predicate alone decides.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const relay = new WebhookTextChannelRelay({ webhookUrl: FAKE_URL });
    await relay.postTranscript("something said", {
      durationSec: 1,
      isLive: () => false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
