#!/usr/bin/env node
/**
 * sync-plugin-version.mjs
 *
 * Rewrites `PLUGIN_VERSION` in src/constants.ts from `version` in package.json,
 * so the manifest the host reads always reports the published package version.
 *
 * Wired as the npm `version` lifecycle script: `npm version 1.2.3` bumps
 * package.json, then this script updates src/constants.ts and stages it, so the
 * version commit carries both. tests/plugin-version.test.ts asserts the two
 * agree, which turns any future drift (issue #74) into a failing test.
 *
 * The constant cannot simply import package.json: tsconfig pins
 * `rootDir: "./src"`, and importing a file above it would move the build output
 * to dist/src/, breaking the `paperclipPlugin` entrypoints in package.json.
 *
 * Usage: node scripts/sync-plugin-version.mjs [--check]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const constantsPath = join(repoRoot, "src", "constants.ts");
const packagePath = join(repoRoot, "package.json");

const packageVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
if (typeof packageVersion !== "string" || packageVersion.length === 0) {
  console.error("sync-plugin-version: package.json has no usable version field");
  process.exit(1);
}

const source = readFileSync(constantsPath, "utf8");
const pattern = /^(export const PLUGIN_VERSION = ")([^"]*)(";)$/m;
const match = source.match(pattern);
if (!match) {
  console.error("sync-plugin-version: could not find the PLUGIN_VERSION declaration in src/constants.ts");
  process.exit(1);
}

const currentVersion = match[2];
const checkOnly = process.argv.includes("--check");

if (currentVersion === packageVersion) {
  console.log(`sync-plugin-version: PLUGIN_VERSION already matches package.json (${packageVersion})`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `sync-plugin-version: drift — PLUGIN_VERSION is ${currentVersion}, package.json is ${packageVersion}. ` +
      "Run `node scripts/sync-plugin-version.mjs` to fix.",
  );
  process.exit(1);
}

writeFileSync(constantsPath, source.replace(pattern, `$1${packageVersion}$3`));
console.log(`sync-plugin-version: PLUGIN_VERSION ${currentVersion} -> ${packageVersion}`);
