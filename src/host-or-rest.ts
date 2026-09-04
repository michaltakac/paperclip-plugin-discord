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
  /**
   * Only the host SDK supplies this. The REST payload has no equivalent —
   * `unblockDescriptor` and `blockerAttention` are different things — so a
   * blocked-issue list read over REST simply omits the reason rather than
   * inventing one.
   */
  blockerReason?: string;
};
export type CompanyRow = { id: string; name?: string };
export type ProjectRow = { id: string; name?: string; status?: string; description?: string | null };

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

/**
 * What "open" means: everything except finished work.
 *
 * `/clip issues` is titled "Open Issues" but asked for no status at all, so it
 * listed the ten most recent issues whatever their state — mostly Done and
 * Cancelled. Paperclip accepts repeated `status=` parameters, so the filter can
 * be stated exactly instead of approximated.
 */
export const OPEN_ISSUE_STATUSES: IssueStatus[] = [
  "todo", "in_progress", "in_review", "blocked", "backlog",
];

export function listIssues(
  ctx: PluginContext,
  companyId: string,
  baseUrl: string,
  apiKey?: string,
  opts: {
    status?: IssueStatus;
    /** Repeated `status=` params; the API unions them. */
    statuses?: IssueStatus[];
    limit?: number;
    projectId?: string;
  } = {},
): Promise<IssueRow[]> {
  const query = new URLSearchParams();
  if (opts.status) query.set("status", opts.status);
  for (const st of opts.statuses ?? []) query.append("status", st);
  if (opts.projectId) query.set("projectId", opts.projectId);
  if (opts.limit) query.set("limit", String(opts.limit));
  const suffix = query.toString() ? `?${query}` : "";
  const wanted = new Set<string>(opts.statuses ?? []);
  return sdkOrRest(
    async () => {
      // The host SDK takes a single status, so a multi-status request is made
      // unfiltered and narrowed here. Fetch wider than the limit first, or the
      // page could be all finished work and come back empty.
      const { statuses: _statuses, ...sdkOpts } = opts;
      const rows = (await ctx.issues.list({
        companyId,
        ...sdkOpts,
        ...(wanted.size ? { limit: Math.max(opts.limit ?? 10, 100) } : {}),
      })) as IssueRow[];
      const narrowed = wanted.size ? rows.filter((r) => wanted.has(r.status)) : rows;
      return opts.limit ? narrowed.slice(0, opts.limit) : narrowed;
    },
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

export function listProjects(
  ctx: PluginContext,
  companyId: string,
  baseUrl: string,
  apiKey?: string,
  limit = 100,
): Promise<ProjectRow[]> {
  return sdkOrRest(
    () =>
      (
        ctx as unknown as {
          projects: { list(a: { companyId: string; limit: number }): Promise<ProjectRow[]> };
        }
      ).projects.list({ companyId, limit }),
    async () =>
      asList<ProjectRow>(
        await restJson(baseUrl, `/api/companies/${companyId}/projects?limit=${limit}`, apiKey),
        "projects",
      ),
  );
}

export function getIssue(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  baseUrl: string,
  apiKey?: string,
): Promise<IssueRow | null> {
  return sdkOrRest(
    () => ctx.issues.get(issueId, companyId) as Promise<IssueRow | null>,
    async () => {
      try {
        return (await restJson<IssueRow>(baseUrl, `/api/issues/${encodeURIComponent(issueId)}`, apiKey)) ?? null;
      } catch {
        return null; // a missing issue is a null, not an error
      }
    },
  );
}
