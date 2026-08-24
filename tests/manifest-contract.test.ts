import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import manifest from "../src/manifest.js";
import { PLUGIN_VERSION } from "../src/constants.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  version: string;
};

const configSchema = manifest.instanceConfigSchema as {
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
};

const SECRET_REF_FIELDS = ["discordBotTokenRef", "paperclipBoardApiKeyRef"];

describe("manifest version (issue #74)", () => {
  it("reports the published package version", () => {
    expect(PLUGIN_VERSION).toBe(packageJson.version);
    expect(manifest.version).toBe(packageJson.version);
  });
});

describe("capabilities the bootstrap depends on", () => {
  it("declares companies.read", () => {
    // The startup walk calls `companies.list`, which the SDK maps to the
    // `companies.read` capability (host-client-factory.ts). Without it declared,
    // the walk is denied on every host and the plugin can only ever start from an
    // onConfigChanged delivery.
    expect(manifest.capabilities).toContain("companies.read");
  });

  it("declares secrets.read-ref", () => {
    expect(manifest.capabilities).toContain("secrets.read-ref");
  });
});

describe("secret-ref config schema (issues #61, #72)", () => {
  it("declares every secret-ref field as string OR object", () => {
    // The host validates config with Ajv against this schema BEFORE its
    // secret-ref extractor runs, and that extractor rejects bare UUID strings on
    // every `format: "secret-ref"` path. A `type: "string"` field can therefore
    // never be saved: the picker's object binding fails Ajv, and a pasted UUID
    // fails the extractor.
    for (const field of SECRET_REF_FIELDS) {
      const property = configSchema.properties[field];
      expect(property, `missing schema for ${field}`).toBeDefined();
      expect(property.type, `${field} must accept both stored shapes`).toEqual(["string", "object"]);
      expect(property.format).toBe("secret-ref");
    }
  });

  it("declares no default on a secret-ref field", () => {
    // An empty-string default fails the same extractor on a fresh install.
    for (const field of SECRET_REF_FIELDS) {
      expect(configSchema.properties[field]).not.toHaveProperty("default");
    }
  });

  it("still requires the bot token reference", () => {
    expect(configSchema.required).toContain("discordBotTokenRef");
    expect(configSchema.required).toContain("defaultChannelId");
  });

  it("does not tell operators to paste a secret UUID anywhere", () => {
    for (const field of SECRET_REF_FIELDS) {
      const description = String(configSchema.properties[field].description ?? "");
      expect(description.toLowerCase()).not.toContain("paste");
    }
  });
});
