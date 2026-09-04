import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleInteraction, type CommandContext } from "../src/commands.js";

// ---------------------------------------------------------------------------
// /clip link | unlink | whoami
//
// The approval URL is a bearer capability: whoever opens it while signed in to
// Paperclip becomes the account this Discord user acts as. So the strongest
// assertion here is that it is never sent non-ephemerally.
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function ok(body: unknown) {
  return { ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => body, text: async () => "" };
}

function makeCtx(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: {
      get: vi.fn(async ({ stateKey }: any) => store.get(stateKey) ?? null),
      set: vi.fn(async ({ stateKey }: any, v: unknown) => { store.set(stateKey, v); }),
    },
  } as any;
}

const CMD_CTX = { baseUrl: "https://paperclip.example.com", token: "t" } as unknown as CommandContext;

function clip(subName: string, user: { id?: string; username: string } = { id: "111", username: "alice" }) {
  return { type: 2, data: { name: "clip", options: [{ name: subName, options: [] }] }, member: { user } };
}

beforeEach(() => fetchMock.mockReset());

describe("/clip link", () => {
  it("returns the approval URL ephemerally, and only ephemerally", async () => {
    fetchMock.mockResolvedValue(ok({
      id: "ch1", token: "sec", boardApiToken: "pcp_board_x",
      approvalUrl: "https://paperclip.example.com/cli-auth/ch1?token=sec",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      status: "pending",
    }));
    const res: any = await handleInteraction(makeCtx(), clip("link"), CMD_CTX);
    const payload = res?.data ?? res;
    const text = JSON.stringify(payload);
    expect(text).toContain("cli-auth/ch1");
    // Discord marks ephemeral with flags 64, or an `ephemeral` passthrough.
    expect(payload.flags === 64 || payload.ephemeral === true).toBe(true);
  });

  it("does not mint a second link when already linked", async () => {
    const ctx = makeCtx({ "identity_link:111": { paperclipUserId: "user-abc", discordUserId: "111", linkedAt: "now" } });
    const res: any = await handleInteraction(ctx, clip("link"), CMD_CTX);
    expect(JSON.stringify(res)).toContain("user-abc");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when Discord gives no user id", async () => {
    const res: any = await handleInteraction(makeCtx(), clip("link", { username: "alice" }), CMD_CTX);
    expect(JSON.stringify(res)).toMatch(/user id/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains itself when Paperclip is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res: any = await handleInteraction(makeCtx(), clip("link"), CMD_CTX);
    expect(JSON.stringify(res)).toMatch(/couldn't start the link/i);
  });
});

describe("/clip whoami and /clip unlink", () => {
  it("whoami reports the linked account, and never a credential", async () => {
    const ctx = makeCtx({ "identity_link:111": { paperclipUserId: "user-abc", discordUserId: "111", linkedAt: "2026-09-04" } });
    const res: any = await handleInteraction(ctx, clip("whoami"), CMD_CTX);
    const text = JSON.stringify(res);
    expect(text).toContain("user-abc");
    expect(text).not.toMatch(/pcp_/);
  });

  it("whoami tells an unlinked user what they get instead", async () => {
    const res: any = await handleInteraction(makeCtx(), clip("whoami"), CMD_CTX);
    expect(JSON.stringify(res)).toContain("discord:");
  });

  it("whoami completes an approved link, then revokes the board key", async () => {
    // Pull-based completion: /clip link stores the challenge, the human
    // approves in the browser, and the next command turns it into a link.
    const ctx = makeCtx({
      "identity_pending:111": {
        id: "ch1", token: "sec", boardToken: "pcp_board_x",
        approvalUrl: "u", expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    fetchMock
      .mockResolvedValueOnce(ok({ status: "approved" }))
      .mockResolvedValueOnce(ok({ userId: "user-xyz", keyId: "key-9" }))
      .mockResolvedValueOnce(ok({}));
    const res: any = await handleInteraction(ctx, clip("whoami"), CMD_CTX);
    expect(JSON.stringify(res)).toContain("user-xyz");
    const del = fetchMock.mock.calls.find(([, i]) => (i as any)?.method === "DELETE");
    expect(del, "board key must be revoked once identity is known").toBeTruthy();
    expect(ctx.store.get("identity_pending:111")).toBeNull();
  });

  it("whoami stays quiet while the link is still pending", async () => {
    const ctx = makeCtx({
      "identity_pending:111": {
        id: "ch1", token: "sec", boardToken: "t", approvalUrl: "u",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    fetchMock.mockResolvedValueOnce(ok({ status: "pending" }));
    const res: any = await handleInteraction(ctx, clip("whoami"), CMD_CTX);
    expect(JSON.stringify(res)).toContain("Not linked");
  });

  it("unlink removes the mapping and is idempotent", async () => {
    const ctx = makeCtx({ "identity_link:111": { paperclipUserId: "user-abc", discordUserId: "111", linkedAt: "now" } });
    expect(JSON.stringify(await handleInteraction(ctx, clip("unlink"), CMD_CTX))).toMatch(/unlinked/i);
    expect(JSON.stringify(await handleInteraction(ctx, clip("unlink"), CMD_CTX))).toMatch(/weren't linked/i);
  });
});
