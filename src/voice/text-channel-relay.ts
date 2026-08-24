/**
 * POST utterance transcripts to a Discord text channel via webhook, so the room
 * can see what the bot heard.
 *
 * This is DISPLAY ONLY. The utterance reaches Paperclip through the plugin's
 * inbound ingress (see src/voice/client.ts), not through this post, and nothing
 * reads this post back: the inbound router refuses bot authors and non-replies,
 * and voice does not ask it for an exception. A transcript therefore cannot loop
 * back in as input, and no webhook is a trusted message source.
 *
 * Discord webhook payload shape: { content, username, allowed_mentions }.
 * Success = 204 No Content. We retry once on 5xx; hard-fail 4xx.
 *
 * Mention safety: transcripts are machine-generated from whatever was said out
 * loud, so `content` is fully attacker-influenced text. Speech recognition will
 * happily render "at everyone" as "@everyone", and a webhook with default
 * mention parsing would then mass-ping the channel. `allowed_mentions` is
 * pinned to an empty parse list on every request: the literal text still shows,
 * but nothing in a transcript can ever ping anyone. This is deliberately not a
 * string-rewriting filter — Discord's own allow-list is the authoritative
 * control, and it cannot be evaded by unicode tricks or novel mention syntax.
 *
 * Empty / whitespace-only transcripts are skipped — nothing meaningful was
 * said and posting noise to the channel defeats the audit-trail value.
 */

import { DEFAULT_RELAY_USERNAME, type TextChannelRelay } from "./types.js";

/**
 * Discord's allowed_mentions object with an empty parse list: no @everyone,
 * no @here, no role pings, no user pings — regardless of message content.
 */
export const NO_MENTIONS = { parse: [] as string[] };

interface RelayConfig {
  webhookUrl: string;
  /** Display username for the webhook posts. Default: "Voice". */
  username?: string;
}

export class WebhookTextChannelRelay implements TextChannelRelay {
  private readonly webhookUrl: string;
  private readonly username: string;

  constructor(cfg: RelayConfig) {
    this.webhookUrl = cfg.webhookUrl;
    this.username = cfg.username ?? DEFAULT_RELAY_USERNAME;
  }

  async postTranscript(
    text: string,
    metadata: { durationSec: number; isLive?: () => boolean },
  ): Promise<void> {
    const isLive = metadata.isLive ?? (() => true);
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      // Skip empty/whitespace — nothing meaningful was said.
      return;
    }

    const body = JSON.stringify({
      content: trimmed,
      username: this.username,
      allowed_mentions: NO_MENTIONS,
    });

    // First attempt
    let resp = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    // Retry once on 5xx.
    //
    // The first attempt was launched while the caller still had standing; this
    // one would not be. Posting spans an await, and the client can be stopped
    // inside it — by a retirement, a gateway replacement, or shutdown — so a
    // retry decided purely by the response status would start a fresh display
    // write into a channel this client has already left. Ask again first.
    if (resp.status >= 500 && resp.status < 600) {
      if (!isLive()) return;
      resp = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "<no body>");
      throw new Error(
        `webhook POST failed: ${resp.status} ${resp.statusText} — ${errBody}`,
      );
    }
  }
}
