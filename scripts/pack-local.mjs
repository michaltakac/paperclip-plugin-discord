#!/usr/bin/env node
/**
 * Build a runtime-only package tree for a Paperclip LOCAL-PATH install.
 *
 * Paperclip's install dialog only accepts npm names, but the API, CLI and
 * install guard all accept a local path — which is how every plugin on our
 * instance is installed. A local path is NOT an npm install, so nothing runs
 * `npm install` for it: whatever the worker imports at runtime has to be
 * present in the directory you hand it.
 *
 * That is the trap this script exists to close. `@paperclipai/plugin-sdk` is a
 * devDependency (correct — it is only needed to build), so a naive copy of
 * `dist/` + `package.json` installs cleanly and then dies at worker start with
 * ERR_MODULE_NOT_FOUND.
 *
 * Voice deps are deliberately excluded: `voice/index.js` is a lazy import with
 * its own "install these" fallback, so leaving them out costs 14 MB instead of
 * hundreds and only disables voice.
 *
 *   node scripts/pack-local.mjs [outDir]
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? "/tmp/ordillect-discord-plugin";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

// Pinned to the exact versions this build was compiled against.
const RUNTIME_DEPS = {
  "@paperclipai/plugin-sdk": pkg.devDependencies["@paperclipai/plugin-sdk"].replace(/^[\^~]/, ""),
  ws: pkg.devDependencies.ws,
};

execFileSync("npm", ["run", "build"], { stdio: "inherit" });

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const entry of ["dist", "README.md", "LICENSE"]) {
  cpSync(entry, join(outDir, entry), { recursive: true });
}

writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      type: "module",
      main: pkg.main,
      engines: pkg.engines,
      dependencies: RUNTIME_DEPS,
    },
    null,
    2,
  ) + "\n",
);

execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: outDir,
  stdio: "inherit",
});

console.log(`\nStaged ${pkg.name}@${pkg.version} -> ${outDir}`);
console.log("Copy it to <paperclip-data>/plugin-src/ordillect-discord on the host, then install with");
console.log('  POST /api/plugins/install {"packageName":"/paperclip/plugin-src/ordillect-discord","isLocalPath":true}');
