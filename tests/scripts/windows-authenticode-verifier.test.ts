import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { verifyWindowsAuthenticode } from "../../scripts/windows-authenticode-verifier.mjs";

const thumbprint = "A".repeat(40);
const valid = { Status: "Valid", Subject: "CN=Example Signer", Thumbprint: thumbprint };
const output = (record: unknown): string =>
  Buffer.from(JSON.stringify(record), "utf8").toString("base64");
const successfulChild = {
  status: 0,
  signal: null,
  error: undefined,
  stderr: "",
  stdout: output(valid),
};

describe("Windows Authenticode native boundary", () => {
  it("uses a fixed command and passes even metacharacter paths only through the environment", () => {
    const run = vi.fn().mockReturnValue(successfulChild);
    const path = "C:\\release\\literal' ; $danger.exe";

    const result = verifyWindowsAuthenticode(path, run);

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    const [program, args, options] = run.mock.calls[0] ?? [];
    expect(program).toBe("powershell.exe");
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    expect(args.join(" ")).toContain(
      "Get-AuthenticodeSignature -LiteralPath $env:GOGMEET_AUTHENTICODE_PATH -ErrorAction Stop",
    );
    expect(args.join(" ")).not.toContain(path);
    expect(options.env.GOGMEET_AUTHENTICODE_PATH).toBe(path);
    expect(options.shell).toBe(false);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.maxBuffer).toBeGreaterThan(0);
  });

  it.each([
    ["unsigned", { ...valid, Status: "NotSigned" }],
    ["unknown status", { ...valid, Status: "UnknownError" }],
    ["missing certificate", { ...valid, Subject: "" }],
    ["missing thumbprint", { ...valid, Thumbprint: "" }],
    ["extra field", { ...valid, Extra: "unexpected" }],
    ["array", [valid]],
  ])("rejects %s native result", (_name, record) => {
    const result = verifyWindowsAuthenticode(
      "C:\\fixture.exe",
      vi.fn().mockReturnValue({
        ...successfulChild,
        stdout: output(record),
      }),
    );

    expect(result.ok).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["extra output", `${output(valid)}\n${output(valid)}`],
    ["malformed base64", "%%%"],
    ["malformed JSON", Buffer.from("{", "utf8").toString("base64")],
    ["invalid UTF-8", Buffer.from([0xff]).toString("base64")],
  ])("rejects %s output", (_name, stdout) => {
    const result = verifyWindowsAuthenticode(
      "C:\\fixture.exe",
      vi.fn().mockReturnValue({
        ...successfulChild,
        stdout,
      }),
    );

    expect(result.ok).toBe(false);
  });

  it.each([
    ["unavailable PowerShell", { error: new Error("ENOENT"), status: null }],
    ["nonzero exit", { status: 1 }],
    ["timeout", { error: new Error("ETIMEDOUT"), status: null, signal: "SIGTERM" }],
    ["signal", { status: null, signal: "SIGTERM" }],
    ["overflow", { error: new Error("ENOBUFS"), status: null }],
    ["stderr", { stderr: "unexpected output" }],
  ])("rejects %s", (_name, fault) => {
    const result = verifyWindowsAuthenticode(
      "C:\\fixture.exe",
      vi.fn().mockReturnValue({
        ...successfulChild,
        ...fault,
      }),
    );

    expect(result.ok).toBe(false);
  });

  it.skipIf(process.platform !== "win32")(
    "accepts a Microsoft-signed Windows system executable using real Windows PowerShell",
    () => {
      const systemRoot = process.env["SystemRoot"];
      if (systemRoot === undefined) {
        throw new Error("SystemRoot is required for the Windows signed fixture");
      }
      const path = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

      const result = verifyWindowsAuthenticode(path);

      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/^Valid signer [a-fA-F0-9]{40}$/);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects known unsigned harmless fixture using real Windows PowerShell",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "gogmeet-unsigned-native-"));
      try {
        const path = join(directory, "unsigned.exe");
        writeFileSync(path, Buffer.alloc(2048));

        const result = verifyWindowsAuthenticode(path);

        expect(result.ok).toBe(false);
        expect(result.message).toContain("Authenticode status");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
