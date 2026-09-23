import { spawnSync } from "node:child_process";

const PATH_VARIABLE = "GOGMEET_AUTHENTICODE_PATH";
const COMMAND =
  "$ErrorActionPreference='Stop'; $signature=Get-AuthenticodeSignature -LiteralPath $env:GOGMEET_AUTHENTICODE_PATH -ErrorAction Stop; $record=@{Status=[string]$signature.Status; Subject=[string]$signature.SignerCertificate.Subject; Thumbprint=[string]$signature.SignerCertificate.Thumbprint}; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress -Depth 3)))";

/** @param {string} path @param {typeof spawnSync} [run] */
export function verifyWindowsAuthenticode(path, run = spawnSync) {
  const child = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", COMMAND], {
    env: { ...process.env, [PATH_VARIABLE]: path },
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 16 * 1024,
    windowsHide: true,
    shell: false,
  });
  if (child.error || child.signal || child.status !== 0 || child.stderr !== "") {
    return {
      ok: false,
      message: `PowerShell verification failed: ${child.error?.message ?? child.signal ?? child.status}`,
    };
  }
  const encoded = child.stdout.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return { ok: false, message: "PowerShell returned malformed signature output" };
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    return { ok: false, message: "PowerShell returned malformed signature output" };
  }
  let record;
  try {
    record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    return {
      ok: false,
      message: `PowerShell returned invalid signature JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).sort().join(",") !== "Status,Subject,Thumbprint" ||
    record.Status !== "Valid" ||
    typeof record.Subject !== "string" ||
    record.Subject.trim().length === 0 ||
    typeof record.Thumbprint !== "string" ||
    !/^[a-fA-F0-9]{40}$/.test(record.Thumbprint)
  ) {
    return {
      ok: false,
      message: "Authenticode status is not Valid or signer certificate evidence is missing",
    };
  }
  return { ok: true, message: `Valid signer ${record.Thumbprint}` };
}
