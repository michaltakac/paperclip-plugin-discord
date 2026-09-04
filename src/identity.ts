/**
 * Discord ↔ Paperclip identity linking.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every Discord-originated write is currently attributed to the synthetic
 * string `discord:{username}` — `decidedByUserId`, `assigneeUserId`,
 * `resolvedBy`, inbound reply comments. In `authenticated` deployments the
 * request itself is made with ONE shared operator board API key, so Paperclip
 * sees the operator acting, and the Discord username survives only as a label.
 *
 * That means an approval clicked by a contributor and one clicked by the
 * founder are indistinguishable to Paperclip's own authorization and audit
 * trail, and `assigneeUserId: "discord:someone"` never resolves to a real user.
 *
 * This module lets a Discord user prove, once, that they own a Paperclip
 * account, and records the mapping. Attribution then uses their REAL Paperclip
 * user id.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not store a credential. The link uses Paperclip's existing CLI
 * device-code flow to establish identity, reads the user id, and then REVOKES
 * the board key it was issued. Only `{ paperclipUserId, linkedAt }` is
 * persisted. A dump of plugin state therefore yields no usable secret — which
 * is what makes this safe to enable by default.
 */

import { readState, writeState } from "./safe-state.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { paperclipFetch } from "./paperclip-fetch.js";

/** Prefix for the synthetic actor used when a Discord user has not linked. */
export const UNLINKED_ACTOR_PREFIX = "discord:";

/** How long a user has to approve before the link attempt gives up. */
export const LINK_TIMEOUT_MS = 10 * 60 * 1000;
export const LINK_POLL_MS = 2000;

export type IdentityLink = {
  paperclipUserId: string;
  discordUserId: string;
  discordUsername?: string;
  linkedAt: string;
};

export type PendingChallenge = {
  id: string;
  token: string;
  boardToken: string;
  approvalUrl: string;
  expiresAt: string;
};

function stateKey(discordUserId: string): string {
  return `identity_link:${discordUserId}`;
}

function pendingKey(discordUserId: string): string {
  return `identity_pending:${discordUserId}`;
}

export async function savePending(
  ctx: PluginContext,
  discordUserId: string,
  pending: PendingChallenge | null,
): Promise<void> {
  await writeState(ctx, { scopeKind: "instance", stateKey: pendingKey(discordUserId) }, pending);
}

export async function getPending(
  ctx: PluginContext,
  discordUserId: string,
): Promise<PendingChallenge | null> {
  const raw = await readState(ctx, { scopeKind: "instance", stateKey: pendingKey(discordUserId) });
  return (raw as PendingChallenge | null | undefined) ?? null;
}

/**
 * One non-blocking check of an outstanding link.
 *
 * Pull-based on purpose: a plugin runs inside the host runtime, so an
 * interaction handler must not leave a long-lived poll running behind it. The
 * user approves in the browser and then runs a command; that command drives
 * this. Returns the link when approval has happened, otherwise null.
 */
export async function tryCompleteLink(
  ctx: PluginContext,
  baseUrl: string,
  discordUserId: string,
  discordUsername: string | undefined,
  now: () => number = () => Date.now(),
): Promise<IdentityLink | null> {
  const pending = await getPending(ctx, discordUserId);
  if (!pending) return null;

  if (pending.expiresAt && new Date(pending.expiresAt).getTime() <= now()) {
    await savePending(ctx, discordUserId, null);
    return null;
  }

  let state: Record<string, any>;
  try {
    const res = await paperclipFetch(
      `${baseUrl}/api/cli-auth/challenges/${encodeURIComponent(pending.id)}?token=${encodeURIComponent(pending.token)}`,
    );
    state = (await res.json()) as Record<string, any>;
  } catch {
    return null; // transient; the next command retries
  }

  if (state.status !== "approved") {
    if (state.status === "cancelled" || state.status === "expired") {
      await savePending(ctx, discordUserId, null);
    }
    return null;
  }

  const meRes = await paperclipFetch(`${baseUrl}/api/cli-auth/me`, {}, pending.boardToken);
  const me = (await meRes.json()) as Record<string, any>;
  const link: IdentityLink = {
    paperclipUserId: String(me.userId),
    discordUserId,
    discordUsername,
    linkedAt: new Date(now()).toISOString(),
  };
  await saveLink(ctx, link);
  await savePending(ctx, discordUserId, null);
  // The credential existed only to prove who this is.
  await revokeBoardKey(baseUrl, pending.boardToken, me.keyId);
  return link;
}

export async function getLink(
  ctx: PluginContext,
  discordUserId: string,
): Promise<IdentityLink | null> {
  const raw = await readState(ctx, { scopeKind: "instance", stateKey: stateKey(discordUserId) });
  return (raw as IdentityLink | null | undefined) ?? null;
}

export async function saveLink(ctx: PluginContext, link: IdentityLink): Promise<void> {
  await writeState(ctx, { scopeKind: "instance", stateKey: stateKey(link.discordUserId) }, link);
}

export async function removeLink(ctx: PluginContext, discordUserId: string): Promise<boolean> {
  const existing = await getLink(ctx, discordUserId);
  if (!existing) return false;
  await writeState(ctx, { scopeKind: "instance", stateKey: stateKey(discordUserId) }, null);
  return true;
}

/**
 * The user id to attribute a Discord action to.
 *
 * Falls back to the existing `discord:{username}` string when the user has not
 * linked, so behaviour is unchanged for everyone who never runs `/clip link`.
 */
export async function resolveActorUserId(
  ctx: PluginContext,
  discordUserId: string | undefined,
  username: string | undefined,
): Promise<string> {
  const fallback = `${UNLINKED_ACTOR_PREFIX}${username ?? "unknown"}`;
  if (!discordUserId) return fallback;
  try {
    const link = await getLink(ctx, discordUserId);
    return link?.paperclipUserId ?? fallback;
  } catch {
    // Identity is an enhancement; a state read failure must never block the
    // action the user actually asked for.
    return fallback;
  }
}

/** True when the id came from a real Paperclip account rather than the fallback. */
export function isLinkedActor(actorUserId: string): boolean {
  return !actorUserId.startsWith(UNLINKED_ACTOR_PREFIX);
}

/** Step 1 — ask Paperclip for a device-code challenge. Grants nothing yet. */
export async function beginLink(
  baseUrl: string,
  discordUsername: string | undefined,
  companyId?: string,
  /**
   * Where the human opens Paperclip. Paperclip builds `approvalUrl` from the
   * origin the REQUEST arrived on, so a plugin calling an internal address gets
   * back something like http://127.0.0.1:3102/cli-auth/... — which no browser
   * can open. When set, the link is rebuilt from `approvalPath` instead.
   */
  publicBaseUrl?: string,
): Promise<PendingChallenge> {
  const res = await paperclipFetch(`${baseUrl}/api/cli-auth/challenges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // Both strings are shown on Paperclip's approval screen, so the human can
      // see who is asking before consenting.
      command: `Discord identity link — ${discordUsername ?? "a Discord user"}`,
      clientName: "Discord plugin",
      requestedAccess: "board",
      ...(companyId ? { requestedCompanyId: companyId } : {}),
    }),
  });
  const body = (await res.json()) as Record<string, any>;
  const publicBase = (publicBaseUrl ?? "").replace(/\/+$/, "");
  const approvalUrl =
    publicBase && body.approvalPath
      ? `${publicBase}${body.approvalPath}`
      : String(body.approvalUrl ?? body.approvalPath ?? "");
  return {
    id: String(body.id),
    token: String(body.token),
    boardToken: String(body.boardApiToken),
    approvalUrl,
    expiresAt: String(body.expiresAt ?? ""),
  };
}

/**
 * Step 2 — wait for approval, read the identity, then throw the credential
 * away. Returns null if the user declined or never approved.
 */
export async function awaitLink(
  ctx: PluginContext,
  baseUrl: string,
  pending: PendingChallenge,
  discordUserId: string,
  discordUsername: string | undefined,
  opts: { timeoutMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<IdentityLink | null> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.timeoutMs ?? LINK_TIMEOUT_MS);

  for (;;) {
    const res = await paperclipFetch(
      `${baseUrl}/api/cli-auth/challenges/${encodeURIComponent(pending.id)}?token=${encodeURIComponent(pending.token)}`,
    );
    const state = (await res.json()) as Record<string, any>;

    if (state.status === "approved") {
      const meRes = await paperclipFetch(`${baseUrl}/api/cli-auth/me`, {}, pending.boardToken);
      const me = (await meRes.json()) as Record<string, any>;
      const link: IdentityLink = {
        paperclipUserId: String(me.userId),
        discordUserId,
        discordUsername,
        linkedAt: new Date(now()).toISOString(),
      };
      await saveLink(ctx, link);
      // The credential has served its only purpose: proving who this is.
      await revokeBoardKey(baseUrl, pending.boardToken, me.keyId);
      return link;
    }

    if (state.status === "cancelled" || state.status === "expired") return null;

    if (now() >= deadline) {
      // Leave nothing a late approval could activate.
      await cancelChallenge(baseUrl, pending).catch(() => {});
      return null;
    }
    await sleep(opts.pollMs ?? LINK_POLL_MS);
  }
}

/**
 * Revoke the board key minted for the link. Best-effort: failing to revoke
 * must not fail the link, but it is attempted first so the common path leaves
 * no live credential behind.
 */
export async function revokeBoardKey(
  baseUrl: string,
  boardToken: string,
  keyId: unknown,
): Promise<boolean> {
  if (!keyId || typeof keyId !== "string") return false;
  try {
    await paperclipFetch(
      `${baseUrl}/api/board-api-keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE" },
      boardToken,
    );
    return true;
  } catch {
    return false;
  }
}

export async function cancelChallenge(baseUrl: string, pending: PendingChallenge): Promise<void> {
  await paperclipFetch(`${baseUrl}/api/cli-auth/challenges/${encodeURIComponent(pending.id)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: pending.token }),
  });
}
