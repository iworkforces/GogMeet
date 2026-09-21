#!/usr/bin/env node
/**
 * Windows release artifact verifier (Wave 6 MVP inventory checks).
 *
 * Expects electron-builder outputs under dist/ for the current package.json
 * version. Official release (Wave 7) can set REQUIRE_UPDATER_YML=1 and
 * REQUIRE_WIN_SIGN=1 for stricter gates.
 *
 * Usage:
 *   node scripts/verify-windows-release.mjs
 *   bun run verify:windows-release
 *
 * Exit 0 on success; non-zero with a clear message on failure.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWindowsLatestYml } from "./windows-latest-yml-verifier.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("package.json version is missing");
  }
  return pkg.version;
}

/**
 * @param {string} version
 * @returns {string[]}
 */
export function expectedWindowsArtifacts(version) {
  const base = `GogMeet-${version}`;
  return [
    `${base}-x64.exe`,
    `${base}-arm64.exe`,
    `${base}-x64-portable.exe`,
    `${base}-arm64-portable.exe`,
  ];
}

/**
 * @param {{ distDir?: string, requireUpdaterYml?: boolean, files?: string[] }} opts
 */
export function verifyWindowsReleaseInventory(opts = {}) {
  const dir = opts.distDir ?? distDir;
  const version = readVersion();
  const expected = expectedWindowsArtifacts(version);
  const onDisk = opts.files ?? (existsSync(dir) ? readdirSync(dir) : []);

  const missing = expected.filter((name) => !onDisk.includes(name));
  if (missing.length > 0) {
    return {
      ok: false,
      version,
      expected,
      missing,
      message: `Missing Windows artifacts for v${version}: ${missing.join(", ")}`,
    };
  }

  for (const name of expected) {
    const full = join(dir, name);
    if (!existsSync(full)) {
      return {
        ok: false,
        version,
        expected,
        missing: [name],
        message: `Missing file on disk: ${full}`,
      };
    }
    const st = statSync(full);
    if (!st.isFile() || st.size < 1024) {
      return {
        ok: false,
        version,
        expected,
        missing: [],
        message: `Artifact too small or not a file: ${name} (${st.size} bytes)`,
      };
    }
  }

  const requireYml = opts.requireUpdaterYml === true || process.env["REQUIRE_UPDATER_YML"] === "1";
  if (requireYml) {
    const ymlPath = join(dir, "latest.yml");
    if (!existsSync(ymlPath)) {
      return {
        ok: false,
        version,
        expected,
        missing: ["latest.yml"],
        message: "REQUIRE_UPDATER_YML=1 but dist/latest.yml is missing",
      };
    }
    const validation = verifyWindowsLatestYml({
      metadata: readFileSync(ymlPath, "utf-8"),
      version,
      distDir: dir,
    });
    if (!validation.ok) {
      return {
        ok: false,
        version,
        expected,
        missing: [],
        message: validation.message,
      };
    }
  }

  return {
    ok: true,
    version,
    expected,
    missing: [],
    message: `OK: ${expected.length} Windows artifacts present for v${version}`,
  };
}

function main() {
  try {
    const result = verifyWindowsReleaseInventory();
    if (!result.ok) {
      console.error(`[verify-windows-release] ${result.message}`);
      process.exit(1);
    }
    console.log(`[verify-windows-release] ${result.message}`);
  } catch (err) {
    console.error("[verify-windows-release]", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main();
}
