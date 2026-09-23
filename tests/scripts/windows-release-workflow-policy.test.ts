import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflows = [
  ["release.yml", "release-win"],
  ["beta-release.yml", "beta-win"],
] as const;

function windowsJobSteps(file: string, jobName: string): { job: string; steps: string[] } {
  const workflow = readFileSync(
    new URL(`../../.github/workflows/${file}`, import.meta.url),
    "utf8",
  );
  const job = workflow
    .split(/^  (?=[\w-]+:)/m)
    .find((section) => section.startsWith(`${jobName}:\n`));
  expect(job).toBeDefined();
  const steps = job
    ?.split(/^    steps:\s*$/m)[1]
    ?.split(/^      - /m)
    .slice(1);
  expect(steps?.length).toBeGreaterThan(0);
  return { job: job ?? "", steps: steps ?? [] };
}

describe.each(workflows)("%s Windows release policy", (file, jobName) => {
  const { job, steps } = windowsJobSteps(file, jobName);
  const signingSteps = steps.filter((step) =>
    /^          WIN_CSC_LINK: \$\{\{ secrets\.WIN_CSC_LINK \}\}$/m.test(step),
  );

  it.each([
    [
      "both credentials",
      "fixture-link",
      "fixture-password",
      ["CSC_LINK=fixture-link", "CSC_KEY_PASSWORD=fixture-password", "REQUIRE_WIN_SIGN=1"],
    ],
    ["missing link", "", "fixture-password", []],
    ["missing password", "fixture-link", "", []],
    ["missing both", "", "", []],
  ])("exports signing variables only with %s", (_case, link, password, expected) => {
    expect(signingSteps).toHaveLength(1);
    const signing = signingSteps[0] ?? "";
    expect(signing).toMatch(
      /^          WIN_CSC_KEY_PASSWORD: \$\{\{ secrets\.WIN_CSC_KEY_PASSWORD \}\}$/m,
    );
    expect(signing).not.toMatch(/^        if:/m);
    expect(job.replace(signing, "")).not.toMatch(/REQUIRE_WIN_SIGN|CSC_LINK=|CSC_KEY_PASSWORD=/);

    const script = signing.match(/^        run: \|\n([\s\S]*)$/m)?.[1]?.replace(/^ {10}/gm, "");
    expect(script).toBeDefined();
    const directory = mkdtempSync(join(tmpdir(), "gogmeet-win-signing-policy-"));
    try {
      const envFile = join(directory, "github-env");
      writeFileSync(envFile, "");
      const result = spawnSync("bash", ["-c", script ?? ""], {
        encoding: "utf8",
        env: {
          ...process.env,
          WIN_CSC_LINK: link,
          WIN_CSC_KEY_PASSWORD: password,
          GITHUB_ENV: envFile.replaceAll("\\", "/"),
        },
      });

      expect(
        result.status,
        `bash status ${result.status}, error: ${result.error?.message ?? "none"}, stderr: ${result.stderr}`,
      ).toBe(0);
      expect(readFileSync(envFile, "utf8").split("\n")).toEqual([...expected, ""]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds both arches, merges updater metadata, verifies before checksums and upload", () => {
    expect(job).toMatch(/^\s*runs-on: windows-latest$/m);
    expect(job).toMatch(/^\s*shell: bash$/m);
    const commands = steps.map((step) => step.match(/^        run: (bun run [\w:-]+)$/m)?.[1]);
    const sequence = [
      "bun run package:win:x64",
      "bun run package:win:arm64",
      "bun run merge:windows-latest-yml",
      "bun run verify:windows-release",
    ];
    const indices = sequence.map((command) => commands.indexOf(command));
    expect(indices.every((index) => index >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((left, right) => left - right));
    for (const index of indices) {
      expect(steps[index]).not.toMatch(/^        if:/m);
    }

    const verifier = steps[indices[3] ?? -1] ?? "";
    expect(verifier).toMatch(/^          REQUIRE_UPDATER_YML: ["']1["']$/m);
    expect(verifier).not.toMatch(/^        if:/m);
    expect(indices[0]).toBeGreaterThan(steps.indexOf(signingSteps[0] ?? ""));
    const checksumIndex = steps.findIndex((step) =>
      /^ {10,}> dist\/SHA256SUMS-win\.txt$/m.test(step),
    );
    const uploadIndex = steps.findIndex(
      (step) =>
        /^        uses: softprops\/action-gh-release@/m.test(step) &&
        /dist\/SHA256SUMS-win\.txt/.test(step),
    );
    expect(checksumIndex).toBeGreaterThan(indices[3] ?? -1);
    expect(uploadIndex).toBeGreaterThan(checksumIndex);
    expect(steps[checksumIndex]).not.toMatch(/^        if:/m);
    expect(steps[uploadIndex]).not.toMatch(/^        if:/m);
    expect(steps[uploadIndex]).toMatch(/^          fail_on_unmatched_files: true$/m);
    expect(steps[uploadIndex]).toMatch(/^            dist\/latest\.yml$/m);
  });
});
