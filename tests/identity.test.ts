import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Discord ↔ Paperclip identity linking.
//
// The property that matters most here is NOT that linking works — it is that
// the plugin never retains a credential. The link exists only to learn a user
// id; the board key it is issued must be revoked immediately after.
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
  beginLink,
  awaitLink,
  getLink,
  saveLink,
  removeLink,
  resolveActorUserId,
  isLinkedActor,
  UNLINKED_ACTOR_PREFIX,
} from "../src/identity.js";

function ok(body: unknown) {
  return { ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => body, text: async () => "" };
}

/** In-memory stand-in for the host's state store. */
function fakeCtx() {
  const store = new Map<string, unknown>();
  return {
    store,
    state: {
      get: vi.fn(async ({ stateKey }: any) => store.get(stateKey) ?? null),
      set: vi.fn(async ({ stateKey }: any, value: unknown) => { store.set(stateKey, value); }),
    },
  } as any;
}

const BASE = "https://paperclip.example.com";

beforeEach(() => fetchMock.mockReset());

describe("attribution", () => {
  it("falls back to the existing discord: string when unlinked", async () => {
    // Behaviour must be unchanged for anyone who never runs /clip link.
    const ctx = fakeCtx();
    expect(await resolveActorUserId(ctx, "111", "alice")).toBe(`${UNLINKED_ACTOR_PREFIX}alice`);
    expect(await resolveActorUserId(ctx, undefined, "alice")).toBe(`${UNLINKED_ACTOR_PREFIX}alice`);
    expect(await resolveActorUserId(ctx, "111", undefined)).toBe(`${UNLINKED_ACTOR_PREFIX}unknown`);
  });

  it("uses the real Paperclip user id once linked", async () => {
    const ctx = fakeCtx();
    await saveLink(ctx, { paperclipUserId: "user-abc", discordUserId: "111", linkedAt: "now" });
    expect(await resolveActorUserId(ctx, "111", "alice")).toBe("user-abc");
  });

  it("never blocks the action when state is unavailable", async () => {
    // Identity is an enhancement; a broken state store must not break approvals.
    const ctx = fakeCtx();
    ctx.state.get = vi.fn(async () => { throw new Error("state backend down"); });
    expect(await resolveActorUserId(ctx, "111", "alice")).toBe(`${UNLINKED_ACTOR_PREFIX}alice`);
  });

  it("distinguishes a real id from the fallback", () => {
    expect(isLinkedActor("user-abc")).toBe(true);
    expect(isLinkedActor("discord:alice")).toBe(false);
  });
});

describe("linking", () => {
  it("asks only for board access and names the requester", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "ch1", token: "sec", boardApiToken: "pcp_board_x", approvalUrl: "u", expiresAt: "e" }));
    await beginLink(BASE, "alice", "co-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/api/cli-auth/challenges`);
    const body = JSON.parse((init as any).body);
    expect(body.requestedAccess).toBe("board");
    expect(body.requestedCompanyId).toBe("co-1");
    expect(body.command).toContain("alice");
  });

  it("stores the user id and REVOKES the board key", async () => {
    const ctx = fakeCtx();
    fetchMock
      .mockResolvedValueOnce(ok({ status: "approved" }))                   // poll
      .mockResolvedValueOnce(ok({ userId: "user-abc", keyId: "key-1" }))   // /cli-auth/me
      .mockResolvedValueOnce(ok({}));                                      // DELETE board key
    const link = await awaitLink(
      ctx, BASE,
      { id: "ch1", token: "sec", boardToken: "pcp_board_x", approvalUrl: "u", expiresAt: "e" },
      "111", "alice",
    );
    expect(link?.paperclipUserId).toBe("user-abc");

    const del = fetchMock.mock.calls.find(([, i]) => (i as any)?.method === "DELETE");
    expect(del, "the board key must be revoked after reading the identity").toBeTruthy();
    expect(String(del![0])).toContain("/api/board-api-keys/key-1");

    // And nothing credential-shaped may survive in state.
    expect(JSON.stringify([...ctx.store.values()])).not.toContain("pcp_board_x");
  });

  it("returns null when the user declines", async () => {
    const ctx = fakeCtx();
    fetchMock.mockResolvedValueOnce(ok({ status: "cancelled" }));
    const link = await awaitLink(ctx, BASE, { id: "ch1", token: "sec", boardToken: "t", approvalUrl: "u", expiresAt: "e" }, "111", "alice");
    expect(link).toBeNull();
    expect(await getLink(ctx, "111")).toBeNull();
  });

  it("cancels the challenge on timeout so a late approval cannot activate it", async () => {
    const ctx = fakeCtx();
    fetchMock
      .mockResolvedValueOnce(ok({ status: "pending" }))
      .mockResolvedValueOnce(ok({ status: "cancelled" }));
    const link = await awaitLink(
      ctx, BASE, { id: "ch1", token: "sec", boardToken: "t", approvalUrl: "u", expiresAt: "e" },
      "111", "alice", { timeoutMs: 0 },
    );
    expect(link).toBeNull();
    const cancel = fetchMock.mock.calls.find(([u]) => String(u).includes("/cancel"));
    expect(cancel, "a timed-out challenge must be cancelled").toBeTruthy();
  });

  it("still links when revocation fails", async () => {
    // Losing the revoke is unfortunate but must not strand the user unlinked;
    // the key expires on its own.
    const ctx = fakeCtx();
    fetchMock
      .mockResolvedValueOnce(ok({ status: "approved" }))
      .mockResolvedValueOnce(ok({ userId: "user-abc", keyId: "key-1" }))
      .mockRejectedValueOnce(new Error("network down"));
    const link = await awaitLink(ctx, BASE, { id: "ch1", token: "sec", boardToken: "t", approvalUrl: "u", expiresAt: "e" }, "111", "alice");
    expect(link?.paperclipUserId).toBe("user-abc");
  });

  it("unlink removes the mapping and reports whether it existed", async () => {
    const ctx = fakeCtx();
    await saveLink(ctx, { paperclipUserId: "user-abc", discordUserId: "111", linkedAt: "now" });
    expect(await removeLink(ctx, "111")).toBe(true);
    expect(await getLink(ctx, "111")).toBeNull();
    expect(await removeLink(ctx, "111")).toBe(false);
  });
});
