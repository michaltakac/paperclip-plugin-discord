/**
 * State access that survives an expired invocation scope.
 *
 * The worker keeps one PluginContext from setup() and reuses it for every
 * gateway-delivered interaction. That context's invocation scope EXPIRES, so
 * host calls start failing part-way through a worker's life:
 *
 *   not allowed to perform "state.get":
 *   the worker referenced a missing, expired, or unknown invocation scope
 *
 * An unguarded state read then throws out of the interaction handler, the
 * gateway never sends a callback, and Discord shows "The application did not
 * respond" — with no error visible to the user at all.
 *
 * So every state access goes through here. When the host refuses:
 *   - reads return the in-memory value, or null (i.e. "not configured")
 *   - writes are kept in memory so the current worker still behaves correctly
 *
 * The in-memory tier is explicitly a degraded mode, not a cache layer: it is
 * per-worker and lost on restart. It keeps commands answering instead of
 * timing out, which is the difference between a degraded feature and a bot
 * that looks dead.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isInvocationScopeError } from "./host-or-rest.js";

/**
 * Durable tier.
 *
 * The in-memory tier below keeps a worker answering, but it is per-process and
 * lost on restart — so anything the plugin stores (imported workflows, identity
 * links, digest settings) would silently evaporate. Writing to disk instead
 * makes that state outlive the worker AND land inside the container filesystem,
 * which is what the estate's backups already cover.
 *
 * Default lives under the Paperclip data mount, so it is a real path on the
 * host and gets picked up by whatever backs that host up. Override with
 * DISCORD_PLUGIN_STATE_DIR.
 */
const DISK_DIR =
  process.env.DISCORD_PLUGIN_STATE_DIR?.trim() || "/paperclip/plugin-state/discord";

let diskUsable: boolean | null = null;

/** One file per scope. The name is derived, never taken from user input. */
function fileFor(scope: StateScope): string {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return join(DISK_DIR, `${safe(scope.scopeKind)}__${safe(scope.scopeId ?? "_")}__${safe(scope.stateKey)}.json`);
}

function readDisk<T>(scope: StateScope): T | null {
  try {
    return JSON.parse(readFileSync(fileFor(scope), "utf8")) as T;
  } catch {
    return null;
  }
}

/** Write-then-rename so a crash cannot leave a truncated state file. */
function writeDisk(ctx: PluginContext, scope: StateScope, value: unknown): boolean {
  const target = fileFor(scope);
  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(value ?? null, null, 2), { mode: 0o600 });
    renameSync(tmp, target);
    diskUsable = true;
    return true;
  } catch (err) {
    if (diskUsable !== false) {
      diskUsable = false;
      ctx?.logger?.warn?.(
        "Plugin state directory is not writable; state will not survive a worker restart",
        { dir: DISK_DIR, error: err instanceof Error ? err.message : String(err) },
      );
    }
    return false;
  }
}

export type StateScope = {
  scopeKind: "instance" | "company" | string;
  scopeId?: string;
  stateKey: string;
};

const memory = new Map<string, unknown>();
let warned = false;

function keyOf(scope: StateScope): string {
  return `${scope.scopeKind}:${scope.scopeId ?? ""}:${scope.stateKey}`;
}

function noteDegraded(ctx: PluginContext, method: string): void {
  if (warned) return;
  warned = true;
  ctx?.logger?.warn?.(
    "Plugin state is unavailable (invocation scope expired); falling back to in-memory state for this worker. " +
      "Stored values will not survive a restart.",
    { method },
  );
}

/** Read state. Never throws — a denial or a missing value both yield null. */
export async function readState<T = unknown>(
  ctx: PluginContext,
  scope: StateScope,
): Promise<T | null> {
  // Disk wins when present: it is written on every successful set, so it is the
  // most recent value. Consulting the host first would resurrect a stale value
  // from before the scope expired.
  const onDisk = readDisk<T>(scope);
  if (onDisk !== null) return onDisk;

  try {
    const value = (await ctx.state.get(scope as never)) as T | null | undefined;
    // Seed the durable tier from pre-existing host state, so upgrading does not
    // lose what the plugin had already stored.
    if (value != null) writeDisk(ctx, scope, value);
    return value ?? null;
  } catch (err) {
    if (!isInvocationScopeError(err)) {
      // A genuine backend failure is worth surfacing in logs, but still must
      // not take the interaction down.
      ctx?.logger?.warn?.("state.get failed", {
        stateKey: scope.stateKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    noteDegraded(ctx, "state.get");
    return (memory.get(keyOf(scope)) as T | undefined) ?? null;
  }
}

/** Write state. Never throws; falls back to in-memory on a scope denial. */
export async function writeState(
  ctx: PluginContext,
  scope: StateScope,
  value: unknown,
): Promise<boolean> {
  // Durable first, so a host failure can never lose the write.
  const persisted = writeDisk(ctx, scope, value);
  if (persisted) memory.set(keyOf(scope), value);

  try {
    await ctx.state.set(scope as never, value as never);
    return true;
  } catch (err) {
    if (persisted) {
      // Already durable; the host copy is a nice-to-have for its own tooling.
      if (isInvocationScopeError(err)) noteDegraded(ctx, "state.set");
      return true;
    }
    if (!isInvocationScopeError(err)) {
      ctx?.logger?.warn?.("state.set failed", {
        stateKey: scope.stateKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    noteDegraded(ctx, "state.set");
    memory.set(keyOf(scope), value);
    return false;
  }
}

/** Test seam. */
export function _resetSafeState(): void {
  memory.clear();
  warned = false;
  diskUsable = null;
}

/** Where durable state is written. Exposed for diagnostics and tests. */
export function stateDirectory(): string {
  return DISK_DIR;
}
