import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectedWindowsArtifacts } from "../../scripts/verify-windows-release.mjs";

describe("Windows release CLI signing environment", () => {
  it.each([
    ["absent", false],
    ["required", true],
  ])("uses native signing only when REQUIRE_WIN_SIGN is %s", (_name, required) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gogmeet-win-release-cli-")));
    try {
      const scripts = join(root, "scripts");
      const dist = join(root, "dist");
      mkdirSync(scripts);
      mkdirSync(dist);
      const version = "9.8.7";
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", version }));
      for (const name of [
        "verify-windows-release.mjs",
        "windows-latest-yml-verifier.mjs",
        "windows-authenticode-verifier.mjs",
      ]) {
        copyFileSync(new URL(`../../scripts/${name}`, import.meta.url), join(scripts, name));
      }
      for (const name of expectedWindowsArtifacts(version)) {
        writeFileSync(join(dist, name), Buffer.alloc(2048));
      }
      const { REQUIRE_WIN_SIGN: _sign, REQUIRE_UPDATER_YML: _yml, ...environment } = process.env;

      const child = spawnSync(process.execPath, [join(scripts, "verify-windows-release.mjs")], {
        env: required ? { ...environment, REQUIRE_WIN_SIGN: "1" } : environment,
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 16 * 1024,
        shell: false,
      });

      expect(child.error).toBeUndefined();
      expect(child.status).toBe(required ? 1 : 0);
      if (required) {
        expect(child.stderr).toContain(expectedWindowsArtifacts(version)[0]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
