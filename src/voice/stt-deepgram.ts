/**
 * Deepgram streaming STT adapter.
 *
 * One WebSocket per utterance. Send the raw 16-bit PCM as binary frames, then
 * `{"type":"Finalize"}` to flush whatever the endpointer is still holding, then
 * `{"type":"CloseStream"}` to say no more audio is coming.
 *
 * A single utterance can come back as SEVERAL `is_final: true` messages —
 * Deepgram finalizes a span whenever its endpointer decides one ended, not once
 * per request — and the complete utterance is the concatenation of those spans.
 * Resolving on the first one silently truncates every longer sentence, so every
 * finalized span is accumulated and the promise settles only at the end of the
 * request: the `from_finalize` acknowledgement of our flush, the closing
 * `Metadata` summary, or the socket closing, whichever arrives first.
 *
 * API reference: https://developers.deepgram.com/docs/streaming
 *   Endpointing / interim results: https://developers.deepgram.com/docs/understand-endpointing-interim-results
 *   Finalize: https://developers.deepgram.com/docs/finalize
 */

import { WebSocket } from "ws";

import type { STTAdapter } from "./types.js";

/**
 * Ceiling on one utterance's round trip. Without it a Deepgram socket that
 * accepts the audio and then goes quiet — no results, no close — leaves the
 * promise pending forever, and with it the utterance handler that awaits it.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

interface DeepgramConfig {
  apiKey: string;
  /** Override the WS base URL; useful for tests. Default: wss://api.deepgram.com */
  baseUrl?: string;
  /** Deepgram model. Default: nova-2 */
  model?: string;
  /** Ceiling on one transcription round trip. Default: 15000 ms. */
  requestTimeoutMs?: number;
}

export class DeepgramSTTAdapter implements STTAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly requestTimeoutMs: number;

  constructor(cfg: DeepgramConfig) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl ?? "wss://api.deepgram.com";
    this.model = cfg.model ?? "nova-2";
    this.requestTimeoutMs = cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async transcribeUtterance(pcm: Buffer): Promise<string> {
    const url =
      `${this.baseUrl}/v1/listen` +
      `?encoding=linear16&sample_rate=48000&channels=1` +
      `&model=${encodeURIComponent(this.model)}&punctuate=true&interim_results=false`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });

      /** Every `is_final: true` span, in arrival order. */
      const segments: string[] = [];
      let sawFinal = false;
      let settled = false;

      const timer = setTimeout(() => {
        // Never quote the URL or the key: this message reaches the plugin log.
        finish(new Error("Deepgram request timed out before the transcript was complete"));
      }, this.requestTimeoutMs);
      // A pending timer must not hold the process open on its own.
      timer.unref?.();

      /** The single settle path: first caller wins, everything else is a no-op. */
      function finish(error?: Error): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // Already closing or closed; nothing to do.
        }
        if (error) {
          reject(error);
          return;
        }
        if (!sawFinal) {
          reject(new Error("Deepgram WS closed with no final transcript"));
          return;
        }
        resolve(segments.join(" ").replace(/\s+/g, " ").trim());
      }

      ws.on("open", () => {
        ws.send(pcm, { binary: true });
        // Finalize flushes the endpointer; CloseStream says no more audio is
        // coming. Together they make the end of the request deterministic
        // instead of leaving it to a silence timer on Deepgram's side.
        ws.send(JSON.stringify({ type: "Finalize" }));
        ws.send(JSON.stringify({ type: "CloseStream" }));
      });

      ws.on("message", (data, isBinary) => {
        if (isBinary) return; // Deepgram doesn't send binary back
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return; // Non-JSON or malformed; the close/error path still settles us.
        }

        if (msg.is_final === true) {
          const alternatives = (msg.channel as { alternatives?: Array<{ transcript?: unknown }> } | undefined)
            ?.alternatives;
          const transcript = alternatives?.[0]?.transcript;
          if (transcript !== undefined) {
            sawFinal = true;
            const text = String(transcript).trim();
            if (text.length > 0) segments.push(text);
          }
        }

        // End of the request: our flush has been acknowledged, or Deepgram has
        // sent the summary it emits once no further results can arrive.
        if (msg.from_finalize === true || msg.type === "Metadata") {
          finish();
        }
      });

      ws.on("close", () => {
        finish();
      });

      ws.on("error", (err) => {
        finish(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }
}
