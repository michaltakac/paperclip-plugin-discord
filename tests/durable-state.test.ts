import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// State must outlive the worker. The in-memory tier keeps a worker answering
// when the invocation scope expires, but it is per-process — so an imported
// workflow or an identity link would vanish on restart. The durable tier writes
// into the container filesystem, which is what host backups already cover.
// ---------------------------------------------------------------------------

const EXPIRED = "the worker referenced a missing, expired, or unknown invocation scope";
const SCOPE = { scopeKind: "company" as const, scopeId: "co-1", stateKey: "custom_commands" };

let dir: string;
let mod: typeof import("../src/safe-state.js");

function ctx(over: Record<string, unknown> = {}) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: { get: vi.fn().mockRejectedValue(new Error(EXPIRED)), set: vi.fn().mockRejectedValue(new Error(EXPIRED)) },
    ...over,
  } as any;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pdstate-"));
  process.env.DISCORD_PLUGIN_STATE_DIR = dir;
  vi.resetModules();
  mod = await import("../src/safe-state.js");
  mod._resetSafeState();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("persists to disk when the host scope has expired", async () => {
  const c = ctx();
  await mod.writeState(c, SCOPE, { workflows: [{ name: "triage" }] });
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(dir, files[0]!), "utf8"))).toEqual({ workflows: [{ name: "triage" }] });
});

it("survives a worker restart", async () => {
  await mod.writeState(ctx(), SCOPE, { workflows: ["kept"] });
  // A restart is a fresh module: in-memory is gone, disk is not.
  vi.resetModules();
  const fresh = await import("../src/safe-state.js");
  expect(await fresh.readState(ctx(), SCOPE)).toEqual({ workflows: ["kept"] });
});

it("reports success once durable, even though the host write failed", async () => {
  // The caller must not be told the write failed when it is safely on disk.
  expect(await mod.writeState(ctx(), SCOPE, { a: 1 })).toBe(true);
});

it("prefers disk over a stale host value", async () => {
  // The host copy can predate the scope expiring; disk is written on every set.
  await mod.writeState(ctx(), SCOPE, { v: "new" });
  const c = ctx({ state: { get: vi.fn().mockResolvedValue({ v: "stale" }), set: vi.fn() } });
  expect(await mod.readState(c, SCOPE)).toEqual({ v: "new" });
});

it("seeds the durable tier from pre-existing host state", async () => {
  // Upgrading must not lose what the plugin had already stored host-side.
  const c = ctx({ state: { get: vi.fn().mockResolvedValue({ legacy: true }), set: vi.fn() } });
  expect(await mod.readState(c, SCOPE)).toEqual({ legacy: true });
  expect(readdirSync(dir)).toHaveLength(1);
});

it("writes state files unreadable by other users", async () => {
  await mod.writeState(ctx(), SCOPE, { secretish: true });
  const f = join(dir, readdirSync(dir)[0]!);
  expect(statSync(f).mode & 0o777).toBe(0o600);
});

it("degrades to memory, and warns once, when the directory is unwritable", async () => {
  process.env.DISCORD_PLUGIN_STATE_DIR = "/proc/nonexistent/nope";
  vi.resetModules();
  const m2 = await import("../src/safe-state.js");
  const c = ctx();
  await m2.writeState(c, SCOPE, { x: 1 });
  await m2.writeState(c, SCOPE, { x: 2 });
  expect(await m2.readState(c, SCOPE)).toEqual({ x: 2 });
  expect(c.logger.warn.mock.calls.filter((a: any[]) => /not writable/.test(a[0])).length).toBe(1);
});
