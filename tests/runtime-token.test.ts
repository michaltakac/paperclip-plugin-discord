import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  MAX_HEALTH_ERROR_LENGTH,
  SECRET_RESOLUTION_ISSUE_URL,
  isUsableSecretRef,
  normalizeSecretRefId,
  resolveStartupDiscordBotToken,
  summarizeError,
  toSecretRefBinding,
  type DiscordRuntimeHealth,
} from "../src/runtime-token.js";

const GOVERNED_SECRET_ERROR =
  'not allowed to perform "secrets.resolve": company context is required';

function makeContext(resolve: (...args: unknown[]) => Promise<string>): PluginContext {
  return {
    secrets: { resolve: vi.fn(resolve) },
    logger: {
      error: vi.fn(),
    },
  } as unknown as PluginContext;
}

describe("secret-ref normalization", () => {
  it("accepts the settings picker's object binding", () => {
    const ref = { type: "secret_ref", secretId: "secret-uuid", version: "latest" };
    expect(isUsableSecretRef(ref)).toBe(true);
    expect(normalizeSecretRefId(ref)).toBe("secret-uuid");
    expect(toSecretRefBinding(ref)).toEqual({
      type: "secret_ref",
      secretId: "secret-uuid",
      version: "latest",
    });
  });

  it("canonicalizes a legacy bare secret UUID into the object binding", () => {
    // The host rejects EVERY string handed to secrets.resolve, so a legacy config
    // only keeps working because the plugin converts it before resolving.
    expect(isUsableSecretRef(" 11111111-1111-4111-8111-111111111111 ")).toBe(true);
    expect(normalizeSecretRefId(" 11111111-1111-4111-8111-111111111111 ")).toBe("11111111-1111-4111-8111-111111111111");
    expect(toSecretRefBinding(" 11111111-1111-4111-8111-111111111111 ")).toEqual({
      type: "secret_ref",
      secretId: "11111111-1111-4111-8111-111111111111",
      version: "latest",
    });
  });

  it("preserves a numeric pinned version", () => {
    // EnvSecretRefBinding.version is `number | "latest"`.
    expect(toSecretRefBinding({ secretId: "11111111-1111-4111-8111-111111111111", version: 2 })).toEqual({
      type: "secret_ref",
      secretId: "11111111-1111-4111-8111-111111111111",
      version: 2,
    });
  });

  it("passes a host binding through untouched so its extra fields survive", () => {
    const binding = {
      type: "secret_ref",
      secretId: "11111111-1111-4111-8111-111111111111",
      version: 3,
      projectionClass: "env",
    };
    expect(toSecretRefBinding(binding)).toBe(binding);
  });

  it("refuses a string that is not a secret UUID", () => {
    // The host persists such values (its Ajv secret-ref format accepts any string
    // and the extractor rejects only UUID-shaped ones), so a raw bot token pasted
    // into the field reaches the plugin. It must never be treated as a reference.
    for (const value of ["not-a-uuid", "MTIzNDU2Nzg5.GaBcDe.rawBotTokenLookalike", "   "]) {
      expect(isUsableSecretRef(value)).toBe(false);
      expect(toSecretRefBinding(value)).toBeUndefined();
    }
  });

  it("rejects empty, missing and malformed references", () => {
    for (const value of ["", "   ", undefined, null, {}, { type: "secret_ref" }, { secretId: "" }]) {
      expect(isUsableSecretRef(value)).toBe(false);
      expect(toSecretRefBinding(value)).toBeUndefined();
    }
  });
});

describe("summarizeError", () => {
  it("flattens an error to a single line", () => {
    expect(summarizeError(new Error("boom\n  at somewhere"))).toBe("Error: boom at somewhere");
  });

  it("caps very long host errors so health stays readable", () => {
    const summary = summarizeError(new Error("x".repeat(2000)));
    expect(summary.length).toBe(MAX_HEALTH_ERROR_LENGTH);
    expect(summary.endsWith(" [truncated]")).toBe(true);
  });
});

describe("resolveStartupDiscordBotToken", () => {
  it("returns the resolved bot token and marks health ok", async () => {
    const health: DiscordRuntimeHealth[] = [];
    const ctx = makeContext(async () => "bot-token");

    const token = await resolveStartupDiscordBotToken(
      ctx,
      "11111111-1111-4111-8111-111111111111",
      (next) => health.push(next),
      { companyId: "company-1" },
    );

    expect(token).toBe("bot-token");
    expect(health).toEqual([{ status: "ok" }]);
  });

  it("passes the company scope and config path through to the host", async () => {
    const ctx = makeContext(async () => "bot-token");
    const ref = { type: "secret_ref", secretId: "secret-uuid" };

    await resolveStartupDiscordBotToken(ctx, ref, () => {}, { companyId: "company-1" });

    expect(ctx.secrets.resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: "secret-uuid" },
      { companyId: "company-1", configPath: "discordBotTokenRef" },
    );
  });

  it("degrades health with the REAL host error and does not throw", async () => {
    const health: DiscordRuntimeHealth[] = [];
    const ctx = makeContext(async () => {
      throw new Error(GOVERNED_SECRET_ERROR);
    });

    const token = await resolveStartupDiscordBotToken(
      ctx,
      "11111111-1111-4111-8111-111111111111",
      (next) => health.push(next),
      { companyId: "company-1" },
    );

    expect(token).toBeUndefined();
    expect(health).toHaveLength(1);
    expect(health[0].status).toBe("degraded");
    // The host's own diagnosis is what an operator needs — no invented sentence
    // about secret references being "disabled until company-scoped config lands".
    expect(health[0].message).toContain(GOVERNED_SECRET_ERROR);
    expect(health[0].details).toEqual({
      issue: "discord-bot-token-unresolved",
      reference: SECRET_RESOLUTION_ISSUE_URL,
      companyId: "company-1",
    });
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Discord plugin cannot resolve bot token secret; runtime features are disabled",
      {
        error: `Error: ${GOVERNED_SECRET_ERROR}`,
        companyId: "company-1",
        reference: SECRET_RESOLUTION_ISSUE_URL,
      },
    );
  });

  it("degrades health without calling the host when the reference is empty", async () => {
    const health: DiscordRuntimeHealth[] = [];
    const ctx = makeContext(async () => "bot-token");

    const token = await resolveStartupDiscordBotToken(ctx, "", (next) => health.push(next), {
      companyId: "company-1",
    });

    expect(token).toBeUndefined();
    expect(ctx.secrets.resolve).not.toHaveBeenCalled();
    expect(health[0]).toMatchObject({
      status: "degraded",
      details: { issue: "discord-bot-token-missing" },
    });
    expect(health[0].message).toContain("discordBotTokenRef");
  });
});
