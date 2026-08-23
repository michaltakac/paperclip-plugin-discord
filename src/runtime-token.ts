import type { EnvSecretRefBinding, PluginContext, PluginHealthDiagnostics } from "@paperclipai/plugin-sdk";

export type DiscordRuntimeHealth = PluginHealthDiagnostics & {
  message?: string;
  details?: Record<string, unknown>;
};

/** Tracker issue for company-scoped config + secret resolution on this plugin. */
export const SECRET_RESOLUTION_ISSUE_URL = "https://github.com/mvanhorn/paperclip-plugin-discord/issues/61";

/** Health messages are operator-facing strings, not log sinks — keep them short. */
export const MAX_HEALTH_ERROR_LENGTH = 300;

/**
 * A secret reference as it can appear in stored plugin config.
 *
 * The Paperclip settings picker writes the object binding
 * (`{ type: "secret_ref", secretId, version }`); older hand-written configs
 * carry a bare secret UUID string. Both are accepted everywhere.
 */
export type DiscordSecretRef = string | EnvSecretRefBinding | Record<string, unknown>;

/**
 * Reduce any accepted secret-ref shape to its secret UUID.
 *
 * Use this for map keys, equality checks and logging — never for resolution,
 * which should pass the original binding through so the host sees the
 * version selector too.
 */
export function normalizeSecretRefId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value && typeof value === "object") {
    const secretId = (value as { secretId?: unknown }).secretId;
    if (typeof secretId === "string" && secretId.trim().length > 0) {
      return secretId.trim();
    }
  }
  return undefined;
}

/** True when the config value can actually be handed to `ctx.secrets.resolve`. */
export function isUsableSecretRef(value: unknown): boolean {
  return normalizeSecretRefId(value) !== undefined;
}

/**
 * Pass a stored config value through to `ctx.secrets.resolve` in the shape the
 * SDK expects (`string | EnvSecretRefBinding`), preserving the version selector
 * from the picker binding.
 */
export function toSecretRefBinding(value: unknown): string | EnvSecretRefBinding | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const secretId = normalizeSecretRefId(record);
    if (!secretId) return undefined;
    const binding: EnvSecretRefBinding = { type: "secret_ref", secretId };
    if (typeof record.version === "string") {
      binding.version = record.version as EnvSecretRefBinding["version"];
    }
    return binding;
  }
  return undefined;
}

/**
 * Turn a thrown value into a single-line, length-capped message safe to publish
 * through plugin health. Host errors ("company context is required", "secret not
 * found") are the most useful diagnostic an operator can get, so they are kept
 * verbatim up to the cap — but secrets never travel in error messages, and the
 * cap keeps a stack trace from flooding the health panel.
 */
export function summarizeError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_HEALTH_ERROR_LENGTH) return singleLine;
  const suffix = " [truncated]";
  return `${singleLine.slice(0, MAX_HEALTH_ERROR_LENGTH - suffix.length)}${suffix}`;
}

/**
 * Resolve the Discord bot token without ever throwing.
 *
 * The plugin must survive hosts where resolution is impossible — a pre-2026.720
 * host with the secret-ref kill switch, or a 2026.720/722 host that denies
 * `secrets.resolve` outside a proactive company scope. In those cases the worker
 * stays activated, health goes `degraded` carrying the host's real error, and the
 * runtime is bootstrapped later from `onConfigChanged`.
 */
export async function resolveStartupDiscordBotToken(
  ctx: PluginContext,
  tokenRef: DiscordSecretRef,
  setHealth: (health: DiscordRuntimeHealth) => void,
  options?: { companyId?: string; configPath?: string },
): Promise<string | undefined> {
  const binding = toSecretRefBinding(tokenRef);
  if (!binding) {
    const message = "discordBotTokenRef is missing or empty; configure the Discord bot token secret in plugin settings";
    setHealth({
      status: "degraded",
      message,
      details: {
        issue: "discord-bot-token-missing",
        reference: SECRET_RESOLUTION_ISSUE_URL,
        ...(options?.companyId ? { companyId: options.companyId } : {}),
      },
    });
    return undefined;
  }

  try {
    const token = await ctx.secrets.resolve(binding, {
      companyId: options?.companyId,
      configPath: options?.configPath ?? "discordBotTokenRef",
    });
    setHealth({ status: "ok" });
    return token;
  } catch (err) {
    const error = summarizeError(err);
    setHealth({
      status: "degraded",
      message: `Discord bot token secret could not be resolved: ${error}`,
      details: {
        issue: "discord-bot-token-unresolved",
        reference: SECRET_RESOLUTION_ISSUE_URL,
        ...(options?.companyId ? { companyId: options.companyId } : {}),
      },
    });
    ctx.logger.error("Discord plugin cannot resolve bot token secret; runtime features are disabled", {
      error,
      companyId: options?.companyId,
      reference: SECRET_RESOLUTION_ISSUE_URL,
    });
    return undefined;
  }
}
