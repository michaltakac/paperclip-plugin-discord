import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveCompanyId, _resetCompanyIdCache } from "../src/company-resolver.js";

// ---------------------------------------------------------------------------
// On the gateway path the worker has no invocation scope, so BOTH the
// `company_default` state read and `companies.list` are refused. Before this
// fix resolveCompanyId() degraded to the literal "default", which then 403s:
//
//   GET /api/companies/default/agents -> 403
//   {"error":"User does not have access to this company"}
// ---------------------------------------------------------------------------

const SCOPE_DENIED = "the worker referenced a missing, expired, or unknown invocation scope";

function deniedCtx() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: { get: async () => { throw new Error(SCOPE_DENIED); } },
    companies: { list: async () => { throw new Error(SCOPE_DENIED); } },
  } as any;
}

beforeEach(() => {
  _resetCompanyIdCache();
  vi.unstubAllGlobals();
});

it("resolves the real company over REST when the host denies scope", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, status: 200, headers: new Headers(),
    json: async () => ({ companies: [{ id: "592ddae9-real", name: "Ordillect" }] }),
    text: async () => "",
  }));
  const id = await resolveCompanyId(deniedCtx(), "https://pc.test", "pcp_board_x");
  expect(id).toBe("592ddae9-real");
  expect(id).not.toBe("default");
});

it("still returns the sentinel when REST is unavailable too", async () => {
  // The caller then falls back to the configured companyId; the sentinel must
  // remain distinguishable rather than throwing.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
  expect(await resolveCompanyId(deniedCtx(), "https://pc.test", "k")).toBe("default");
});

it("prefers an explicit /clip connect override", async () => {
  const ctx: any = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: { get: async () => ({ companyId: "chosen-co" }) },
    companies: { list: async () => [{ id: "other" }] },
  };
  expect(await resolveCompanyId(ctx, "https://pc.test", "k")).toBe("chosen-co");
});
