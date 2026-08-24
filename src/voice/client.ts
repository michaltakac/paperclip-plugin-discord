/**
 * Discord voice client (Phase 1, STT inbound only).
 *
 * Joins a Discord voice channel via @discordjs/voice using the custom gateway
 * adapter from ./discord-adapter.ts. For each speaker, listens for an Opus
 * stream that ends after 800 ms of silence (the silence detection IS the VAD —
 * no separate VAD library), decodes to PCM via prism-media, transcribes via
 * Deepgram, and relays the transcript into a text channel by webhook.
 *
 * Out of scope for Phase 1: TTS outbound (Phase 2), per-agent voice lookup
 * (Phase 2), cost guard (Phase 3), latency CI checks (Phase 4).
 */

import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
} from "@discordjs/voice";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import prism from "prism-media";

import { DeepgramSTTAdapter } from "./stt-deepgram.js";
import { WebhookTextChannelRelay } from "./text-channel-relay.js";
import type { STTAdapter, TextChannelRelay, VoiceClientConfig } from "./types.js";

const DEFAULT_SILENCE_MS = 800;
const PCM_SAMPLE_RATE = 48_000;
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2; // 16-bit mono
const OPUS_FRAME_SIZE = 960;
const OPUS_CHANNELS = 1;
const MIN_UTTERANCE_SEC = 0.2;
const CONNECTION_READY_TIMEOUT_MS = 5_000;

/** The one-line install hint every "voice deps are missing" error ends with. */
export const VOICE_DEPS_INSTALL_HINT =
  "npm install @discordjs/voice prism-media opusscript@0.0.8 libsodium-wrappers ws";

/**
 * prism-media does not bundle an Opus codec: it looks for @discordjs/opus,
 * node-opus, opusscript or ffmpeg-static at construction time and throws if it
 * finds none. Without this preflight that failure surfaces only on the first
 * real utterance, inside a per-utterance catch — the bot joins the channel,
 * looks healthy, and silently transcribes nothing. Fail loudly at startup
 * instead, with the command that fixes it.
 */
export function assertOpusEngineAvailable(): void {
  let probe: NodeJS.WritableStream & { destroy(): void };
  try {
    probe = new prism.opus.Decoder({
      frameSize: OPUS_FRAME_SIZE,
      channels: OPUS_CHANNELS,
      rate: PCM_SAMPLE_RATE,
    }) as unknown as NodeJS.WritableStream & { destroy(): void };
  } catch (error) {
    throw new Error(
      "voice: no Opus engine available — prism-media cannot decode incoming " +
        "audio without one, so no transcript would ever be produced. Install " +
        `the optional voice dependencies: ${VOICE_DEPS_INSTALL_HINT}. ` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  probe.destroy();
}

export class VoiceClient {
  private connection: VoiceConnection | null = null;
  private readonly ctx: PluginContext;
  private readonly config: VoiceClientConfig;
  private readonly stt: STTAdapter;
  private readonly relay: TextChannelRelay;
  private readonly silenceMs: number;

  constructor(
    ctx: PluginContext,
    config: VoiceClientConfig,
    stt?: STTAdapter,
    relay?: TextChannelRelay,
  ) {
    this.ctx = ctx;
    this.config = config;
    this.stt = stt ?? new DeepgramSTTAdapter({ apiKey: config.deepgramApiKey });
    this.relay =
      relay ??
      new WebhookTextChannelRelay({
        webhookUrl: config.textChannelWebhookUrl,
        username: config.relayUsername,
      });
    this.silenceMs = config.utteranceEndSilenceMs ?? DEFAULT_SILENCE_MS;
  }

  /** Join the configured voice channel and start listening. */
  async start(): Promise<void> {
    // Before touching the network: verify the decode path can actually work.
    assertOpusEngineAvailable();

    this.connection = joinVoiceChannel({
      channelId: this.config.voiceChannelId,
      guildId: this.config.guildId,
      adapterCreator: this.config.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true, // Phase 1 is inbound-only
    });

    await entersState(
      this.connection,
      VoiceConnectionStatus.Ready,
      CONNECTION_READY_TIMEOUT_MS,
    );

    const receiver = this.connection.receiver;

    receiver.speaking.on("start", (userId) => {
      this.handleUtterance(userId).catch((err) => {
        this.ctx.logger.error("voice: utterance handling failed", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.ctx.logger.info("voice: voice client started", {
      guildId: this.config.guildId,
      channelId: this.config.voiceChannelId,
    });
  }

  /** Disconnect and clean up. */
  stop(): void {
    if (this.connection) {
      // destroy() runs the adapter's destroy(), which unsubscribes the gateway
      // voice handlers registered for this connection.
      this.connection.destroy();
      this.connection = null;
      this.ctx.logger.info("voice: voice client stopped");
    }
  }

  private async handleUtterance(userId: string): Promise<void> {
    if (!this.connection) return;

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: this.silenceMs,
      },
    });

    const decoder = new prism.opus.Decoder({
      frameSize: OPUS_FRAME_SIZE,
      channels: OPUS_CHANNELS,
      rate: PCM_SAMPLE_RATE,
    });

    const chunks: Buffer[] = [];
    return new Promise<void>((resolve) => {
      opusStream
        .pipe(decoder)
        .on("data", (chunk: Buffer) => chunks.push(chunk))
        .on("end", async () => {
          const pcm = Buffer.concat(chunks);
          const durationSec = pcm.length / PCM_BYTES_PER_SECOND;

          if (durationSec < MIN_UTTERANCE_SEC) {
            // Too short to be a real utterance — likely a click or wakeword false-positive.
            resolve();
            return;
          }

          try {
            const transcript = await this.stt.transcribeUtterance(pcm);
            await this.relay.postTranscript(transcript, { durationSec });
          } catch (err) {
            this.ctx.logger.error("voice: STT or relay failed for utterance", {
              userId,
              durationSec: durationSec.toFixed(2),
              error: err instanceof Error ? err.message : String(err),
            });
          }
          resolve();
        })
        .on("error", (err: Error) => {
          this.ctx.logger.error("voice: decode error", {
            userId,
            error: err.message,
          });
          resolve();
        });
    });
  }
}
