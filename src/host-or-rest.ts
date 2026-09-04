/**
 * Read company data through the host SDK, falling back to Paperclip's REST API.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Discord interaction delivered over the GATEWAY is not a top-level plugin
 * invocation, so the long-lived worker's cached PluginContext carries no
 * authorized company. Any company-scoped host call from that path is refused:
 *
 *   not allowed to perform "agents.list":
 *   the worker referenced a missing, expired, or unknown invocation scope
 *
 * (`InvocationScopeDeniedError`, JSON-RPC -32005 — "asks for company-scoped
 * data outside the company authorized for the current top-level plugin
 * invocation".)
 *
 * The webhook interaction path IS an invocation and works fine, but it needs a
 * public HTTPS endpoint. A gateway deployment has no such endpoint by design —
 * that is the whole reason to run the gateway.
 *
 * So on the gateway path we read the same data over Paperclip's REST API using
 * the configured board API key. The SDK is still tried first: on hosts and code
 * paths where the scope IS valid it stays the better route, and this costs one
 * failed call the first time.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { paperclipFetch } from "./paperclip-fetch.js";

/** Does this error mean "the host refused because we have no invocation scope"? */
export function isInvocationScopeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    msg.includes("invocation scope") ||
    msg.includes("company context is required") ||
    (err as { code?: number } | null)?.code === -32005
  );
}

async function restJson<T>(baseUrl: string, path: string, apiKey?: string): Promise<T> {
  const res = await paperclipFetch(`${baseUrl}${path}`, {}, apiKey);
  return (await res.json()) as T;
}

function asList<T>(data: unknown, ...keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  const rec = (data ?? {}) as Record<string, unknown>;
  for (const key of [...keys, "data"]) {
    if (Array.isArray(rec[key])) return rec[key] as T[];
  }
  return [];
}

/**
 * Run `viaSdk`; if the host refuses for lack of invocation scope, run `viaRest`.
 * Any other error propagates — a 500 from the host is not something to paper
 * over with a second request.
 */
export async function sdkOrRest<T>(
  viaSdk: () => Promise<T>,
  viaRest: () => Promise<T>,
): Promise<T> {
  try {
    return await viaSdk();
  } catch (err) {
    if (!isInvocationScopeError(err)) throw err;
    return await viaRest();
  }
}

export type AgentRow = { id: string; name?: string | null; status: string; title?: string | null; role?: string | null };
export type IssueRow = {
  id: string;
  /** Null (not undefined) when absent, matching the SDK's own shape. */
  identifier: string | null;
  title?: string;
  status: string;
  assigneeAgentId?: string | null;
  executionAgentNameKey?: string | null;
  project?: { name?: string } | null;
};
export type CompanyRow = { id: string; name?: string };

export function listAgents(
  ctx: PluginContext,
  companyId: string,
  baseUrl: string,
  apiKey?: string,
): Promise<AgentRow[]> {
  return sdkOrRest(
    () => ctx.agents.list({ companyId }) as Promise<AgentRow[]>,
    async () => asList<AgentRow>(await restJson(baseUrl, `/api/companies/${companyId}/agents`, apiKey), "agents"),
  );
}

/** The status values Paperclip accepts; mirrors the SDK's own union. */
export type IssueStatus =
  | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "backlog" | "cancelled";

export function listIssues(
  ctx: PluginContext,
  companyId: string,
  baseUrl: string,
  apiKey?: string,
  opts: { status?: IssueStatus; limit?: number } = {},
): Promise<IssueRow[]> {
  const query = new URLSearchParams();
  if (opts.status) query.set("status", opts.status);
  if (opts.limit) query.set("limit", String(opts.limit));
  const suffix = query.toString() ? `?${query}` : "";
  return sdkOrRest(
    () => ctx.issues.list({ companyId, ...opts }) as Promise<IssueRow[]>,
    async () =>
      asList<Record<string, unknown>>(
        await restJson(baseUrl, `/api/companies/${companyId}/issues${suffix}`, apiKey),
        "issues",
      ).map(
        (row) =>
          ({
            ...row,
            identifier: (row.identifier as string | null) ?? null,
            status: (row.status as string) ?? "todo",
          }) as IssueRow,
      ),
  );
}

export function listCompanies(
  ctx: PluginContext,
  baseUrl: string,
  apiKey?: string,
): Promise<CompanyRow[]> {
  return sdkOrRest(
    () => ctx.companies.list() as Promise<CompanyRow[]>,
    async () => asList<CompanyRow>(await restJson(baseUrl, `/api/companies`, apiKey), "companies"),
  );
}
