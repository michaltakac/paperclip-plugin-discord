import { describe, it, expect, vi } from "vitest";
import { isInvocationScopeError, sdkOrRest, listAgents } from "../src/host-or-rest.js";

// ---------------------------------------------------------------------------
// A Discord interaction delivered over the GATEWAY is not a top-level plugin
// invocation, so the worker's cached PluginContext has no authorized company
// and every company-scoped host call is refused. Observed live:
//
//   not allowed to perform "agents.list":
//   the worker referenced a missing, expired, or unknown invocation scope
// ---------------------------------------------------------------------------

const LIVE_ERROR =
  'Plugin "42d43baa" is not allowed to perform "agents.list": the worker referenced a missing, expired, or unknown invocation scope';

describe("isInvocationScopeError", () => {
  it("recognises the live gateway failure", () => {
    expect(isInvocationScopeError(new Error(LIVE_ERROR))).toBe(true);
  });
  it("recognises the scheduled-job variant and the JSON-RPC code", () => {
    expect(isInvocationScopeError(new Error('not allowed to perform "state.get": company context is required'))).toBe(true);
    expect(isInvocationScopeError(Object.assign(new Error("denied"), { code: -32005 }))).toBe(true);
  });
  it("does NOT swallow unrelated failures", () => {
    // A 500 must surface, not trigger a silent second request.
    expect(isInvocationScopeError(new Error("HTTP 500 internal error"))).toBe(false);
    expect(isInvocationScopeError(new Error("fetch failed"))).toBe(false);
  });
});

describe("sdkOrRest", () => {
  it("prefers the SDK when the scope is valid", async () => {
    const rest = vi.fn();
    expect(await sdkOrRest(async () => "sdk", rest)).toBe("sdk");
    expect(rest).not.toHaveBeenCalled();
  });

  it("falls back to REST only on a scope denial", async () => {
    const out = await sdkOrRest(
      async () => { throw new Error(LIVE_ERROR); },
      async () => "rest",
    );
    expect(out).toBe("rest");
  });

  it("propagates any other error instead of retrying", async () => {
    const rest = vi.fn();
    await expect(sdkOrRest(async () => { throw new Error("boom"); }, rest)).rejects.toThrow("boom");
    expect(rest).not.toHaveBeenCalled();
  });
});

describe("listAgents", () => {
  it("reads via REST with the board key when the host refuses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({ agents: [{ id: "a1", name: "COO", status: "idle" }] }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx: any = { agents: { list: async () => { throw new Error(LIVE_ERROR); } } };

    const agents = await listAgents(ctx, "co-1", "https://pc.test", "pcp_board_x");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("COO");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://pc.test/api/companies/co-1/agents");
    expect((init as any).headers.get("Authorization")).toBe("Bearer pcp_board_x");
    vi.unstubAllGlobals();
  });
});
