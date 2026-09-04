import { describe, it, expect, vi, beforeEach } from "vitest";
import { readState, writeState, _resetSafeState } from "../src/safe-state.js";

// ---------------------------------------------------------------------------
// The worker reuses one PluginContext from setup() for every gateway
// interaction, and that context's invocation scope EXPIRES. Host state calls
// then fail mid-life:
//
//   not allowed to perform "state.get":
//   the worker referenced a missing, expired, or unknown invocation scope
//
// An unguarded read throws out of the handler, the gateway never sends a
// callback, and Discord shows "The application did not respond".
// ---------------------------------------------------------------------------

const EXPIRED = "the worker referenced a missing, expired, or unknown invocation scope";
const SCOPE = { scopeKind: "instance" as const, stateKey: "k" };

function ctx(over: Record<string, unknown> = {}) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    ...over,
  } as any;
}

beforeEach(() => _resetSafeState());

it("reads normally when the scope is valid", async () => {
  const c = ctx({ state: { get: vi.fn().mockResolvedValue({ v: 1 }), set: vi.fn() } });
  expect(await readState(c, SCOPE)).toEqual({ v: 1 });
});

it("returns null instead of throwing when the scope has expired", async () => {
  const c = ctx({ state: { get: vi.fn().mockRejectedValue(new Error(EXPIRED)), set: vi.fn() } });
  await expect(readState(c, SCOPE)).resolves.toBeNull();
});

it("keeps the worker usable: a denied write is readable back in-memory", async () => {
  const c = ctx({
    state: {
      get: vi.fn().mockRejectedValue(new Error(EXPIRED)),
      set: vi.fn().mockRejectedValue(new Error(EXPIRED)),
    },
  });
  expect(await writeState(c, SCOPE, { saved: true })).toBe(false); // not persisted
  expect(await readState(c, SCOPE)).toEqual({ saved: true });      // still works
});

it("warns once, not on every call", async () => {
  const c = ctx({ state: { get: vi.fn().mockRejectedValue(new Error(EXPIRED)), set: vi.fn() } });
  await readState(c, SCOPE);
  await readState(c, SCOPE);
  await readState(c, SCOPE);
  expect(c.logger.warn.mock.calls.filter((a: any[]) => /in-memory/.test(a[0])).length).toBe(1);
});

it("does not mask a genuine backend failure as an expired scope", async () => {
  const c = ctx({ state: { get: vi.fn().mockRejectedValue(new Error("disk on fire")), set: vi.fn() } });
  expect(await readState(c, SCOPE)).toBeNull();
  expect(c.logger.warn).toHaveBeenCalledWith("state.get failed", expect.objectContaining({ stateKey: "k" }));
});

it("never throws, whatever the host does", async () => {
  const c = ctx({ state: { get: vi.fn().mockRejectedValue("a string, not an Error"), set: vi.fn().mockRejectedValue(null) } });
  await expect(readState(c, SCOPE)).resolves.toBeNull();
  await expect(writeState(c, SCOPE, 1)).resolves.toBe(false);
});
