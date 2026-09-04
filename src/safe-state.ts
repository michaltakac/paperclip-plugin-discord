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

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isInvocationScopeError } from "./host-or-rest.js";

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
  ctx.logger.warn(
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
  try {
    const value = (await ctx.state.get(scope as never)) as T | null | undefined;
    return value ?? null;
  } catch (err) {
    if (!isInvocationScopeError(err)) {
      // A genuine backend failure is worth surfacing in logs, but still must
      // not take the interaction down.
      ctx.logger.warn("state.get failed", {
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
  try {
    await ctx.state.set(scope as never, value as never);
    return true;
  } catch (err) {
    if (!isInvocationScopeError(err)) {
      ctx.logger.warn("state.set failed", {
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
}
