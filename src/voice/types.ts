/**
 * Shared types for the Discord voice client (Phase 1, STT-inbound only).
 *
 * Phase 1 scope: join one voice channel, transcribe what is said there, and
 * post each utterance into a text channel via webhook so the plugin's existing
 * text routing handles it exactly as if the speaker had typed it.
 */

import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";

/** Default webhook display name for relayed transcripts. */
export const DEFAULT_RELAY_USERNAME = "Voice";

export interface VoiceClientConfig {
  /** Discord guild (server) ID. */
  guildId: string;
  /** Discord voice channel ID to join on startup. */
  voiceChannelId: string;
  /** Webhook URL of the text channel that transcripts are posted to. */
  textChannelWebhookUrl: string;
  /** Deepgram API key. */
  deepgramApiKey: string;
  /** Webhook display name for relayed transcripts. Default: "Voice". */
  relayUsername?: string;
  /** Silence duration (ms) that ends an utterance. Default: 800. */
  utteranceEndSilenceMs?: number;
  /** Voice connection adapter built over the plugin gateway. See voice/discord-adapter.ts. */
  voiceAdapterCreator: DiscordGatewayAdapterCreator;
}

export interface UtteranceFinalized {
  /** Discord user ID who spoke. */
  userId: string;
  /** Transcript text (final, post-VAD-endpoint). */
  text: string;
  /** Approximate utterance duration in seconds (computed from PCM length). */
  durationSec: number;
  /** ISO timestamp at finalize. */
  finalizedAt: string;
}

export interface STTAdapter {
  /**
   * Send a single utterance (raw 16-bit PCM at 48 kHz mono) and return the final transcript.
   * Throws on transport failure or non-2xx close. Caller decides retry policy.
   */
  transcribeUtterance(pcm: Buffer): Promise<string>;
}

export interface TextChannelRelay {
  /** Post a transcript message to the configured text channel. */
  postTranscript(text: string, metadata: { durationSec: number }): Promise<void>;
}
