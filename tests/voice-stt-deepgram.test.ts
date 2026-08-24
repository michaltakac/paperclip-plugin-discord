import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { DeepgramSTTAdapter } from "../src/voice/stt-deepgram.js";

let mockServer: WebSocketServer | undefined;

function makeServer(handler: (ws: WebSocket) => void): Promise<number> {
  return new Promise((resolve) => {
    mockServer = new WebSocketServer({ port: 0 }, () => {
      const port = (mockServer!.address() as { port: number }).port;
      resolve(port);
    });
    mockServer.on("connection", handler);
  });
}

/** A Results frame as Deepgram sends it. */
function results(transcript: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "Results",
    is_final: true,
    channel: { alternatives: [{ transcript }] },
    ...extra,
  });
}

afterEach(() => {
  mockServer?.close();
  mockServer = undefined;
});

describe("DeepgramSTTAdapter", () => {
  it("sends PCM then Finalize and resolves with the final transcript", async () => {
    let receivedBinary = false;
    let receivedFinalize = false;
    const port = await makeServer((ws) => {
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          receivedBinary = true;
          return;
        }
        const msg = JSON.parse(data.toString());
        if (msg.type === "Finalize") {
          receivedFinalize = true;
          // Deepgram marks the response to a Finalize with from_finalize.
          ws.send(results("hello world", { from_finalize: true }));
        }
      });
    });

    const adapter = new DeepgramSTTAdapter({
      apiKey: "test-key",
      baseUrl: `ws://localhost:${port}`,
    });
    const transcript = await adapter.transcribeUtterance(Buffer.from([1, 2, 3, 4]));

    expect(receivedBinary).toBe(true);
    expect(receivedFinalize).toBe(true);
    expect(transcript).toBe("hello world");
  });

  // F4 regression: a long utterance is finalized as several spans, and the
  // complete transcript is their concatenation. Resolving on the first one
  // dropped everything the speaker said after the first endpointed pause.
  it("concatenates every finalized segment of one utterance", async () => {
    const port = await makeServer((ws) => {
      ws.on("message", (data, isBinary) => {
        if (isBinary || JSON.parse(data.toString()).type !== "Finalize") return;
        ws.send(results("first segment"));
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(results("second segment", { from_finalize: true }));
          }
        }, 25);
      });
    });

    const adapter = new DeepgramSTTAdapter({
      apiKey: "test-key",
      baseUrl: `ws://localhost:${port}`,
    });

    await expect(adapter.transcribeUtterance(Buffer.alloc(1920))).resolves.toBe(
      "first segment second segment",
    );
  });

  it("keeps segments that arrive before a closing Metadata frame", async () => {
    const port = await makeServer((ws) => {
      ws.on("message", (data, isBinary) => {
        if (isBinary || JSON.parse(data.toString()).type !== "Finalize") return;
        ws.send(results("one"));
        ws.send(results("two"));
        ws.send(JSON.stringify({ type: "Metadata", duration: 1.5 }));
      });
    });

    const adapter = new DeepgramSTTAdapter({
      apiKey: "test-key",
      baseUrl: `ws://localhost:${port}`,
    });

    await expect(adapter.transcribeUtterance(Buffer.alloc(1920))).resolves.toBe("one two");
  });

  it("resolves with what it has when the socket closes after the segments", async () => {
    const port = await makeServer((ws) => {
      ws.on("message", (data, isBinary) => {
        if (isBinary || JSON.parse(data.toString()).type !== "Finalize") return;
        ws.send(results("closing segment"));
        setTimeout(() => ws.close(), 10);
      });
    });

    const adapter = new DeepgramSTTAdapter({
      apiKey: "test-key",
      baseUrl: `ws://localhost:${port}`,
    });

    await expect(adapter.transcribeUtterance(Buffer.alloc(1920))).resolves.toBe(
      "closing segment",
    );
  });

  it("rejects on WS close without a final result", async () => {
    const port = await makeServer((ws) => {
      ws.on("message", () => {
        ws.close();
      });
    });

    const adapter = new DeepgramSTTAdapter({
      apiKey: "test-key",
      baseUrl: `ws://localhost:${port}`,
    });

    await expect(
      adapter.transcribeUtterance(Buffer.from([1, 2, 3, 4])),
    ).rejects.toThrow(/no final transcript/i);
  });

  it("rejects on WS auth-failure close", async () => {
    const port = await makeServer((ws) => {
      // simulate Deepgram-style auth-failure close
      ws.close(4001, "unauthorized");
    });

    const adapter = new DeepgramSTTAdapter({
      apiKey: "bad-key",
      baseUrl: `ws://localhost:${port}`,
    });

    await expect(
      adapter.transcribeUtterance(Buffer.from([1, 2, 3, 4])),
    ).rejects.toThrow();
  });

  // A socket that accepts the audio and then says nothing must not leave the
  // utterance handler awaiting a promise that can never settle.
  it("rejects without leaking the socket when the server goes quiet", async () => {
    const port = await makeServer(() => {
      // Accept the connection and never answer.
    });

    const adapter = new DeepgramSTTAdapter({
      apiKey: "test-key",
      baseUrl: `ws://localhost:${port}`,
      requestTimeoutMs: 50,
    });

    await expect(adapter.transcribeUtterance(Buffer.alloc(1920))).rejects.toThrow(
      /timed out/i,
    );
  });

  it("returns empty string when the transcript is empty (silence)", async () => {
    const port = await makeServer((ws) => {
      ws.on("message", (_data, isBinary) => {
        if (!isBinary) {
          ws.send(results("", { from_finalize: true }));
        }
      });
    });

    const adapter = new DeepgramSTTAdapter({
      apiKey: "test-key",
      baseUrl: `ws://localhost:${port}`,
    });
    const transcript = await adapter.transcribeUtterance(Buffer.from([1, 2, 3, 4]));
    expect(transcript).toBe("");
  });

  it("never puts the API key in a failure message", async () => {
    const port = await makeServer((ws) => {
      ws.close(4001, "unauthorized");
    });

    const adapter = new DeepgramSTTAdapter({
      apiKey: "super-secret-key",
      baseUrl: `ws://localhost:${port}`,
    });

    await expect(
      adapter.transcribeUtterance(Buffer.alloc(1920)),
    ).rejects.toSatisfy((err: Error) => !String(err.message).includes("super-secret-key"));
  });
});
