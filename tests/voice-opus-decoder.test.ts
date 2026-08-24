import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Regression test for the blocker found reviewing #58: the voice path shipped
// with prism-media but no Opus engine. prism-media bundles no codec — it looks
// for @discordjs/opus, node-opus, opusscript or ffmpeg-static and throws
// "Could not find an Opus module" without one. The failure surfaced only on the
// first real utterance, inside a per-utterance catch, so the bot joined the
// channel, looked healthy, and transcribed nothing forever.
//
// These tests do two things the old suite could not:
//   1. push real Opus frames through the same decoder configuration client.ts
//      uses, proving an engine is actually installed and wired;
//   2. prove the startup preflight fails loudly, with an install hint, when it
//      is not.
// ---------------------------------------------------------------------------

const PCM_SAMPLE_RATE = 48_000;
const OPUS_FRAME_SIZE = 960; // 20 ms at 48 kHz
const OPUS_CHANNELS = 1;
const BYTES_PER_SAMPLE = 2; // 16-bit
const FRAME_BYTES = OPUS_FRAME_SIZE * OPUS_CHANNELS * BYTES_PER_SAMPLE;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

/** A 440 Hz tone: real signal, so a silent decode cannot pass by accident. */
function tone(frames: number): Buffer {
  const pcm = Buffer.alloc(frames * FRAME_BYTES);
  for (let i = 0; i < frames * OPUS_FRAME_SIZE; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / PCM_SAMPLE_RATE) * 12000);
    pcm.writeInt16LE(value, i * BYTES_PER_SAMPLE);
  }
  return pcm;
}

describe("Opus engine", () => {
  it("is installed — a real encode/decode round-trip produces PCM", async () => {
    const { default: prism } = await import("prism-media");

    const frames = 10; // 200 ms
    const encoder = new prism.opus.Encoder({
      frameSize: OPUS_FRAME_SIZE,
      channels: OPUS_CHANNELS,
      rate: PCM_SAMPLE_RATE,
    });
    const decoder = new prism.opus.Decoder({
      frameSize: OPUS_FRAME_SIZE,
      channels: OPUS_CHANNELS,
      rate: PCM_SAMPLE_RATE,
    });

    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve, reject) => {
      decoder.on("data", (chunk: Buffer) => chunks.push(chunk));
      decoder.on("end", () => resolve());
      decoder.on("error", reject);
      encoder.on("error", reject);
    });

    encoder.pipe(decoder);
    encoder.end(tone(frames));
    await done;

    const pcm = Buffer.concat(chunks);
    // Opus is lossy but frame-aligned: the decode returns the same frame count.
    expect(pcm.length).toBe(frames * FRAME_BYTES);
    // And it is real audio, not silence.
    expect(pcm.some((byte) => byte !== 0)).toBe(true);
  });

  it("decodes with the exact configuration client.ts uses", async () => {
    const { default: prism } = await import("prism-media");
    expect(
      () =>
        new prism.opus.Decoder({
          frameSize: OPUS_FRAME_SIZE,
          channels: OPUS_CHANNELS,
          rate: PCM_SAMPLE_RATE,
        }),
    ).not.toThrow();
  });
});

describe("assertOpusEngineAvailable", () => {
  it("passes when an engine is installed", async () => {
    const { assertOpusEngineAvailable } = await import("../src/voice/client.js");
    expect(() => assertOpusEngineAvailable()).not.toThrow();
  });

  it("throws at startup with an actionable install hint when no engine is present", async () => {
    vi.resetModules();
    vi.doMock("prism-media", () => ({
      default: {
        opus: {
          Decoder: class {
            constructor() {
              throw new Error("Could not find an Opus module!");
            }
          },
        },
      },
    }));

    const { assertOpusEngineAvailable, VOICE_DEPS_INSTALL_HINT } = await import(
      "../src/voice/client.js"
    );

    expect(() => assertOpusEngineAvailable()).toThrow(/no Opus engine available/);
    expect(() => assertOpusEngineAvailable()).toThrow(
      new RegExp(VOICE_DEPS_INSTALL_HINT.replace(/[/@]/g, "\\$&")),
    );
    // The original cause is preserved so the log line is diagnosable.
    expect(() => assertOpusEngineAvailable()).toThrow(/Could not find an Opus module/);
  });
});
