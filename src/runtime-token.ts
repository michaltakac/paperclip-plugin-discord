import type { EnvSecretRefBinding, PluginContext, PluginHealthDiagnostics } from "@paperclipai/plugin-sdk";

export type DiscordRuntimeHealth = PluginHealthDiagnostics & {
  message?: string;
  details?: Record<string, unknown>;
};

/** Tracker issue for company-scoped config + secret resolution on this plugin. */
export const SECRET_RESOLUTION_ISSUE_URL = "https://github.com/mvanhorn/paperclip-plugin-discord/issues/61";

/** Health messages are operator-facing strings, not log sinks — keep them short. */
export const MAX_HEALTH_ERROR_LENGTH = 300;

/** What replaces any supplied value that would otherwise be echoed back out. */
export const REDACTION_PLACEHOLDER = "[redacted]";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A secret reference as it can appear in stored plugin config.
 *
 * The Paperclip settings picker writes the object binding
 * (`{ type: "secret_ref", secretId, version }`); older hand-written configs carry
 * a bare secret UUID string. Both are accepted — but only the object binding is
 * ever sent to the host, because `secrets.resolve` rejects every string
 * (server/src/services/plugin-secrets-handler.ts).
 */
export type DiscordSecretRef = string | EnvSecretRefBinding | Record<string, unknown>;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

/**
 * Reduce any accepted secret-ref shape to its secret UUID.
 *
 * A bare string is accepted ONLY when it is UUID-shaped. The host's Ajv
 * `secret-ref` format accepts any string and its config extractor rejects only
 * UUID-shaped ones, so an operator who types a raw bot token into the field gets
 * it persisted verbatim — this is the last line that keeps such a value from
 * being treated as a reference and shipped to the host.
 */
export function normalizeSecretRefId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return isUuid(trimmed) ? trimmed : undefined;
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
  return toSecretRefBinding(value) !== undefined;
}

/**
 * Convert a stored config value into the object binding the host requires.
 *
 * A valid binding is passed through untouched so host-specific fields
 * (`projectionClass`, `projectionAllowlistKey`) survive. A legacy UUID string is
 * canonicalized to `{ type: "secret_ref", secretId, version: "latest" }`, which
 * is what keeps older configurations working against current hosts.
 */
export function toSecretRefBinding(value: unknown): EnvSecretRefBinding | undefined {
  if (typeof value === "string") {
    const secretId = normalizeSecretRefId(value);
    return secretId ? { type: "secret_ref", secretId, version: "latest" } : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const secretId = normalizeSecretRefId(record);
    if (!secretId) return undefined;
    if (record.type === "secret_ref") {
      // Already the host's shape — hand it back as-is, version selector included.
      return record as unknown as EnvSecretRefBinding;
    }
    const binding: EnvSecretRefBinding = { type: "secret_ref", secretId };
    const version = record.version;
    if (version === "latest" || typeof version === "number") {
      binding.version = version;
    }
    return binding;
  }
  return undefined;
}

/**
 * Explain an unusable secret reference WITHOUT quoting what was supplied — the
 * supplied value may be the secret itself.
 */
export function describeUnusableSecretRef(field: string): string {
  return (
    `${field} does not reference a Paperclip secret. Store the value as a secret, ` +
    "then select it with the secret picker in plugin settings. Never type the value itself into this field."
  );
}

/**
 * Remove supplied values from text that is about to be published.
 *
 * The host interpolates a rejected secret reference into its error message, so
 * anything we forward from the host can carry back whatever was configured.
 * Redaction runs before truncation so a partial value cannot survive the cut.
 * Literal replacement (not a regex) because secrets contain regex metacharacters.
 */
export function redactValues(text: string, values: Array<unknown>): string {
  let out = text;
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const candidate of [value, value.trim()]) {
      if (candidate.length < 4) continue;
      out = out.split(candidate).join(REDACTION_PLACEHOLDER);
    }
  }
  return out;
}

/**
 * Turn a thrown value into a single-line, length-capped message safe to publish
 * through plugin health. Host errors ("company context is required", "secret not
 * found") are the most useful diagnostic an operator can get, so they are kept
 * up to the cap — with any supplied value scrubbed out first.
 */
export function summarizeError(err: unknown, redact: Array<unknown> = []): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const scrubbed = redactValues(raw, redact);
  const singleLine = scrubbed.replace(/\s+/g, " ").trim();
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
  const configPath = options?.configPath ?? "discordBotTokenRef";
  const binding = toSecretRefBinding(tokenRef);
  if (!binding) {
    setHealth({
      status: "degraded",
      message: describeUnusableSecretRef(configPath),
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
      configPath,
    });
    setHealth({ status: "ok" });
    return token;
  } catch (err) {
    // Scrub whatever was configured: the host echoes a rejected reference back.
    const error = summarizeError(err, [tokenRef, binding.secretId]);
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
