import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DISCORD_API_BASE, METRIC_NAMES } from "./constants.js";
import { withRetry } from "./retry.js";

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordComponent {
  type: number;
  components?: DiscordComponent[];
  style?: number;
  label?: string;
  custom_id?: string;
  url?: string;
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordComponent[];
}

export interface DiscordGuildRole {
  id: string;
  name: string;
  position: number;
  permissions: string;
}

export interface DiscordChannelMessage {
  id: string;
  content: string;
  author: { id: string; username: string };
  timestamp: string;
  member?: { roles: string[] };
}

async function discordFetch(
  ctx: PluginContext,
  token: string,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const url = `${DISCORD_API_BASE}${path}`;
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (options.body) {
    init.body = JSON.stringify(options.body);
  }
  return ctx.http.fetch(url, init);
}

function normalizeDiscordPathId(id: string | number): string {
  return String(id);
}

/**
 * Every outbound message suppresses mention parsing.
 *
 * Message text is assembled from Paperclip-sourced values — issue titles,
 * agent display names, agent output, escalation context, digest lines. Any of
 * those can contain `@everyone`, and `content` (unlike embed bodies) pings.
 * `agentDisplayName` is the sharpest example: it is interpolated OUTSIDE the
 * code fence in thread output, so an agent named `@everyone` would mass-ping
 * the server on every message it emits.
 *
 * An empty `parse` list means no @everyone, no @here, no role or user pings,
 * regardless of content. Notification text has no legitimate need to ping, so
 * this is applied unconditionally rather than per call site.
 */
export const NO_MENTIONS = { parse: [] as string[] };

export async function postEmbed(
  ctx: PluginContext,
  token: string,
  channelId: string | number,
  message: DiscordMessage,
): Promise<boolean> {
  const safeChannelId = normalizeDiscordPathId(channelId);
  try {
    await withRetry(async () => {
      const response = await discordFetch(
        ctx,
        token,
        `/channels/${safeChannelId}/messages`,
        {
          method: "POST",
          body: {
            content: message.content,
            embeds: message.embeds,
            components: message.components,
            allowed_mentions: NO_MENTIONS,
          },
        },
      );

      if (!response.ok) {
        const text = await response.text();
        const err = new Error(`Discord API error: ${response.status}`);
        (err as any).status = response.status;
        (err as any).headers = response.headers;
        ctx.logger.warn("Discord API error", {
          status: response.status,
          body: text,
          channelId: safeChannelId,
        });
        throw err;
      }
    });

    await ctx.metrics.write(METRIC_NAMES.sent, 1);
    return true;
  } catch (error) {
    ctx.logger.error("Discord notification delivery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await ctx.metrics.write(METRIC_NAMES.failed, 1);
    return false;
  }
}

export async function postEmbedWithId(
  ctx: PluginContext,
  token: string,
  channelId: string | number,
  message: DiscordMessage,
): Promise<string | null> {
  const safeChannelId = normalizeDiscordPathId(channelId);
  try {
    let messageId: string | null = null;
    await withRetry(async () => {
      const response = await discordFetch(
        ctx,
        token,
        `/channels/${safeChannelId}/messages`,
        {
          method: "POST",
          body: {
            content: message.content,
            embeds: message.embeds,
            components: message.components,
            allowed_mentions: NO_MENTIONS,
          },
        },
      );

      if (!response.ok) {
        const text = await response.text();
        const err = new Error(`Discord API error: ${response.status}`);
        (err as any).status = response.status;
        (err as any).headers = response.headers;
        ctx.logger.warn("Discord API error", {
          status: response.status,
          body: text,
          channelId: safeChannelId,
        });
        throw err;
      }

      const data = (await response.json()) as { id: string };
      messageId = data.id;
    });

    await ctx.metrics.write(METRIC_NAMES.sent, 1);
    return messageId;
  } catch (error) {
    ctx.logger.error("Discord notification delivery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await ctx.metrics.write(METRIC_NAMES.failed, 1);
    return null;
  }
}

export async function registerSlashCommands(
  ctx: PluginContext,
  token: string,
  applicationId: string,
  guildId: string | number,
  commands: Array<{
    name: string;
    description: string;
    options?: unknown[];
  }>,
): Promise<boolean> {
  const safeGuildId = normalizeDiscordPathId(guildId);
  try {
    const response = await discordFetch(
      ctx,
      token,
      `/applications/${applicationId}/guilds/${safeGuildId}/commands`,
      { method: "PUT", body: commands },
    );
    if (!response.ok) {
      const text = await response.text();
      ctx.logger.warn("Failed to register slash commands", {
        status: response.status,
        body: text,
      });
      return false;
    }
    return true;
  } catch (error) {
    ctx.logger.error("Slash command registration failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function getChannelMessages(
  ctx: PluginContext,
  token: string,
  channelId: string | number,
  limit: number = 100,
): Promise<DiscordChannelMessage[]> {
  const safeChannelId = normalizeDiscordPathId(channelId);
  try {
    const response = await discordFetch(
      ctx,
      token,
      `/channels/${safeChannelId}/messages?limit=${limit}`,
    );
    if (!response.ok) return [];
    return (await response.json()) as DiscordChannelMessage[];
  } catch {
    return [];
  }
}

export async function getChannelMessagesAll(
  ctx: PluginContext,
  token: string,
  channelId: string | number,
  opts: {
    maxMessages?: number;
    maxAgeDays?: number;
    pageDelayMs?: number;
    onProgress?: (fetched: number) => void;
  } = {},
): Promise<DiscordChannelMessage[]> {
  const safeChannelId = normalizeDiscordPathId(channelId);
  const maxMessages = opts.maxMessages ?? 5000;
  const maxAgeDays = opts.maxAgeDays ?? 90;
  const pageDelayMs = opts.pageDelayMs ?? 500;
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const allMessages: DiscordChannelMessage[] = [];
  let before: string | undefined;

  while (allMessages.length < maxMessages) {
    const query = before
      ? `/channels/${safeChannelId}/messages?limit=100&before=${before}`
      : `/channels/${safeChannelId}/messages?limit=100`;

    try {
      const response = await discordFetch(ctx, token, query);
      if (!response.ok) break;

      const page = (await response.json()) as DiscordChannelMessage[];
      if (page.length === 0) break;

      for (const msg of page) {
        if (msg.timestamp < cutoff) {
          // Reached max age cutoff
          return allMessages;
        }
        allMessages.push(msg);
      }

      before = page[page.length - 1]!.id;
      opts.onProgress?.(allMessages.length);

      // Rate limit delay between pages
      if (pageDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
      }
    } catch {
      break;
    }
  }

  return allMessages;
}

/** A message as returned by `GET /channels/{id}/messages/{id}`. */
export interface DiscordFullMessage {
  id: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  timestamp: string;
  edited_timestamp?: string | null;
  mentions?: Array<{ id: string; username: string; global_name?: string | null }>;
  attachments?: Array<{ id: string; filename: string }>;
  message_reference?: { message_id?: string; channel_id?: string; guild_id?: string };
  /** Present on replies; null when the replied-to message was deleted. */
  referenced_message?: DiscordFullMessage | null;
}

/** One message by id, or null when it cannot be read. */
export async function getMessage(
  ctx: PluginContext,
  token: string,
  channelId: string | number,
  messageId: string | number,
): Promise<DiscordFullMessage | null> {
  try {
    const response = await discordFetch(
      ctx,
      token,
      `/channels/${normalizeDiscordPathId(channelId)}/messages/${normalizeDiscordPathId(messageId)}`,
    );
    if (!response.ok) {
      ctx.logger.warn("Discord message fetch failed", { status: response.status, channelId, messageId });
      return null;
    }
    return (await response.json()) as DiscordFullMessage;
  } catch (error) {
    ctx.logger.warn("Discord message fetch failed", {
      error: error instanceof Error ? error.message : String(error),
      channelId,
      messageId,
    });
    return null;
  }
}

/**
 * Up to `limit` messages posted just before `messageId`, oldest first.
 * Empty on any failure: this is context, never a reason to fail the caller.
 */
export async function getMessagesBefore(
  ctx: PluginContext,
  token: string,
  channelId: string | number,
  messageId: string | number,
  limit: number,
): Promise<DiscordFullMessage[]> {
  try {
    const response = await discordFetch(
      ctx,
      token,
      `/channels/${normalizeDiscordPathId(channelId)}/messages?before=${normalizeDiscordPathId(messageId)}&limit=${limit}`,
    );
    if (!response.ok) return [];
    const page = (await response.json()) as DiscordFullMessage[];
    return Array.isArray(page) ? page.slice().reverse() : [];
  } catch {
    return [];
  }
}

/**
 * The name a person shows under in this guild: server nickname, else their
 * global display name. Null when neither is set or the lookup fails.
 */
export async function getMemberDisplayName(
  ctx: PluginContext,
  token: string,
  guildId: string | number,
  userId: string | number,
): Promise<string | null> {
  try {
    const response = await discordFetch(
      ctx,
      token,
      `/guilds/${normalizeDiscordPathId(guildId)}/members/${normalizeDiscordPathId(userId)}`,
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { nick?: string | null; user?: { global_name?: string | null } };
    return data.nick || data.user?.global_name || null;
  } catch {
    return null;
  }
}

/** A channel's name, or null. Used for labels only, so failure is not an error. */
export async function getChannelName(
  ctx: PluginContext,
  token: string,
  channelId: string | number,
): Promise<string | null> {
  try {
    const response = await discordFetch(ctx, token, `/channels/${normalizeDiscordPathId(channelId)}`);
    if (!response.ok) return null;
    const data = (await response.json()) as { name?: string };
    return data.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Add the bot's own reaction to a message.
 *
 * Native fetch, not `ctx.http.fetch`: Discord answers 204, and the SDK client
 * rebuilds the response with a body, which throws on a null-body status (the
 * same reason `respondViaCallback` uses native fetch).
 */
export async function addReaction(
  ctx: PluginContext,
  token: string,
  channelId: string | number,
  messageId: string | number,
  emoji: string,
): Promise<boolean> {
  const url =
    `${DISCORD_API_BASE}/channels/${normalizeDiscordPathId(channelId)}` +
    `/messages/${normalizeDiscordPathId(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`;
  try {
    const response = await fetch(url, { method: "PUT", headers: { Authorization: `Bot ${token}` } });
    if (!response.ok) {
      ctx.logger.warn("Discord reaction failed", { status: response.status, channelId, messageId });
    }
    return response.ok;
  } catch (error) {
    ctx.logger.warn("Discord reaction failed", {
      error: error instanceof Error ? error.message : String(error),
      channelId,
      messageId,
    });
    return false;
  }
}

export async function getGuildRoles(
  ctx: PluginContext,
  token: string,
  guildId: string | number,
): Promise<DiscordGuildRole[]> {
  const safeGuildId = normalizeDiscordPathId(guildId);
  try {
    const response = await discordFetch(
      ctx,
      token,
      `/guilds/${safeGuildId}/roles`,
    );
    if (!response.ok) return [];
    return (await response.json()) as DiscordGuildRole[];
  } catch {
    return [];
  }
}

export async function getApplicationId(
  ctx: PluginContext,
  token: string,
): Promise<string | null> {
  try {
    const response = await discordFetch(ctx, token, "/oauth2/applications/@me");
    if (!response.ok) return null;
    const data = (await response.json()) as { id: string };
    return data.id;
  } catch {
    return null;
  }
}

export function respondToInteraction(data: {
  type: number;
  content?: string;
  embeds?: DiscordEmbed[];
  ephemeral?: boolean;
}): unknown {
  return {
    type: data.type,
    data: {
      content: data.content,
      embeds: data.embeds,
      flags: data.ephemeral ? 64 : 0,
    },
  };
}
