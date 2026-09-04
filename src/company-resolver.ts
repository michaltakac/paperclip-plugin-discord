import { readState, writeState } from "./safe-state.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listCompanies } from "./host-or-rest.js";

/**
 * Lazy company-ID resolver — avoids startup-time API calls that can crash
 * worker activation. The resolved value is cached after the first successful call.
 *
 * Multi-company fix: check `company_default` instance state (written by
 * `/clip connect`) before falling back to list-based resolution. The
 * connected company is NOT cached so that `/clip connect` changes take effect
 * immediately without restarting the plugin.
 */
let _cachedCompanyId: string | null = null;

export async function resolveCompanyId(
  ctx: PluginContext,
  baseUrl?: string,
  apiKey?: string,
): Promise<string> {
  // Check if a guild-level default was set via /clip connect — always re-read
  // so that switching companies works without a plugin restart.
  try {
    const connected = (await readState(ctx, { scopeKind: "instance", stateKey: "company_default" })) as { companyId?: string } | null | undefined;
    if (connected?.companyId) {
      return connected.companyId;
    }
  } catch {
    // state API unavailable at this call site — fall through to list-based resolution
  }

  if (_cachedCompanyId) return _cachedCompanyId;
  try {
    // REST fallback matters here: on the gateway path BOTH the state read
    // above and a host companies.list are refused for lack of invocation
    // scope, so without it this always degrades to the literal "default" and
    // every downstream call 403s with "User does not have access to this
    // company".
    const companies = baseUrl
      ? await listCompanies(ctx, baseUrl, apiKey)
      : await ctx.companies.list({ limit: 1 });
    if (companies.length > 0) {
      _cachedCompanyId = companies[0]!.id;
      return _cachedCompanyId;
    }
  } catch (err) {
    ctx.logger.warn("Failed to resolve company ID, falling back to 'default'", { error: String(err) });
  }
  return "default";
}

/** Reset cached company ID (for testing). */
export function _resetCompanyIdCache(): void {
  _cachedCompanyId = null;
}
