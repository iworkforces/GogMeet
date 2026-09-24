/**
 * Encrypted Google OAuth token persistence.
 * Path: {userData}/calendar-auth/google.enc
 *
 * Load failures that are not "file missing" preserve ciphertext on disk.
 * Only explicit clearGoogleTokens() / successful overwrite removes credentials.
 */

import { app, safeStorage } from "electron";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { isObjectRecord } from "../../../domain/entities/type-guards.js";
import { ensureSecureDir, writeSecureFile } from "../../utils/secure-fs.js";
import { getGoogleOAuthClientId } from "./google-client-id.js";

export const GOOGLE_AUTH_SCHEMA_VERSION = 1 as const;

export interface GoogleTokenFileV1 {
  readonly authSchemaVersion: typeof GOOGLE_AUTH_SCHEMA_VERSION;
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiryMs: number;
  readonly email?: string;
  readonly scope?: string;
}

/** Why load failed without deleting the encrypted file (when one exists). */
export type GoogleTokenLoadFailureReason =
  | "missing"
  | "secure-storage-unavailable"
  | "decrypt"
  | "malformed"
  | "schema-mismatch"
  | "client-mismatch";

export type GoogleTokenLoadResult =
  | { kind: "ok"; tokens: GoogleTokenFileV1 }
  | { kind: "err"; reason: GoogleTokenLoadFailureReason; preservedCiphertext: boolean };

const pendingMutations = new Map<string, Promise<void>>();

function serializeMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = pendingMutations.get(path);
  const current = previous ? previous.then(operation) : operation();
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  pendingMutations.set(path, settled);
  void settled.then(() => {
    if (pendingMutations.get(path) === settled) pendingMutations.delete(path);
  });
  return current;
}

function authDir(): string {
  return join(app.getPath("userData"), "calendar-auth");
}

function tokenPath(): string {
  return join(authDir(), "google.enc");
}

/** Absolute path to the encrypted token file (tests / diagnostics). */
export function googleTokenFilePath(): string {
  return tokenPath();
}

function allowPlaintextDev(): boolean {
  return !app.isPackaged && process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] === "1";
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encodePayload(json: string): Buffer {
  if (encryptionAvailable()) {
    return safeStorage.encryptString(json);
  }
  if (allowPlaintextDev()) {
    return Buffer.from(json, "utf-8");
  }
  throw new Error("OS secure storage is unavailable; cannot store Google OAuth tokens");
}

function decodePayload(buf: Buffer): string {
  if (encryptionAvailable()) {
    return safeStorage.decryptString(buf);
  }
  if (allowPlaintextDev()) {
    return buf.toString("utf-8");
  }
  throw new Error("OS secure storage is unavailable; cannot read Google OAuth tokens");
}

function parseTokenFile(
  raw: unknown,
):
  | { ok: true; tokens: GoogleTokenFileV1 }
  | { ok: false; reason: "schema-mismatch" | "client-mismatch" } {
  if (!isObjectRecord(raw)) return { ok: false, reason: "schema-mismatch" };
  if (raw["authSchemaVersion"] !== GOOGLE_AUTH_SCHEMA_VERSION) {
    return { ok: false, reason: "schema-mismatch" };
  }
  if (typeof raw["clientId"] !== "string" || raw["clientId"].length === 0) {
    return { ok: false, reason: "schema-mismatch" };
  }
  if (typeof raw["accessToken"] !== "string" || raw["accessToken"].length === 0) {
    return { ok: false, reason: "schema-mismatch" };
  }
  if (typeof raw["refreshToken"] !== "string" || raw["refreshToken"].length === 0) {
    return { ok: false, reason: "schema-mismatch" };
  }
  if (typeof raw["expiryMs"] !== "number" || !Number.isFinite(raw["expiryMs"])) {
    return { ok: false, reason: "schema-mismatch" };
  }

  const expectedClientId = getGoogleOAuthClientId();
  if (expectedClientId.length > 0 && raw["clientId"] !== expectedClientId) {
    return { ok: false, reason: "client-mismatch" };
  }

  const base: GoogleTokenFileV1 = {
    authSchemaVersion: GOOGLE_AUTH_SCHEMA_VERSION,
    clientId: raw["clientId"],
    accessToken: raw["accessToken"],
    refreshToken: raw["refreshToken"],
    expiryMs: raw["expiryMs"],
  };

  const email = raw["email"];
  const scope = raw["scope"];
  return {
    ok: true,
    tokens: {
      ...base,
      ...(typeof email === "string" && email.length > 0 ? { email } : {}),
      ...(typeof scope === "string" && scope.length > 0 ? { scope } : {}),
    },
  };
}

function decodeTokenFile(buf: Buffer): GoogleTokenLoadResult {
  if (!encryptionAvailable() && !allowPlaintextDev()) {
    return { kind: "err", reason: "secure-storage-unavailable", preservedCiphertext: true };
  }

  let json: string;
  try {
    json = decodePayload(buf);
  } catch (err) {
    console.warn("[calendar:auth] Failed to decrypt tokens (ciphertext preserved):", err);
    return { kind: "err", reason: "decrypt", preservedCiphertext: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.warn("[calendar:auth] Token JSON malformed (ciphertext preserved):", err);
    return { kind: "err", reason: "malformed", preservedCiphertext: true };
  }

  const tokens = parseTokenFile(parsed);
  if (!tokens.ok) {
    console.warn(`[calendar:auth] Token ${tokens.reason} (ciphertext preserved)`);
    return { kind: "err", reason: tokens.reason, preservedCiphertext: true };
  }
  return { kind: "ok", tokens: tokens.tokens };
}

/**
 * Load tokens with typed failure. Never unlinks the ciphertext file on
 * decrypt/malformed/schema/client/secure-storage failures.
 */
export async function loadGoogleTokensResult(): Promise<GoogleTokenLoadResult> {
  let buf: Buffer;
  try {
    buf = await readFile(tokenPath());
  } catch {
    return { kind: "err", reason: "missing", preservedCiphertext: false };
  }
  return decodeTokenFile(buf);
}

/** Load tokens or null. Invalid/unreadable files are preserved, not deleted. */
export async function loadGoogleTokens(): Promise<GoogleTokenFileV1 | null> {
  const result = await loadGoogleTokensResult();
  return result.kind === "ok" ? result.tokens : null;
}

function sameTokens(left: GoogleTokenFileV1, right: GoogleTokenFileV1): boolean {
  return (
    left.authSchemaVersion === right.authSchemaVersion &&
    left.clientId === right.clientId &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiryMs === right.expiryMs &&
    left.email === right.email &&
    left.scope === right.scope
  );
}

async function currentTokensMatch(path: string, expected: GoogleTokenFileV1): Promise<boolean> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  const result = decodeTokenFile(buf);
  return result.kind === "ok" && sameTokens(result.tokens, expected);
}

async function persistTokens(
  path: string,
  tokens: GoogleTokenFileV1,
  canPersist?: () => boolean,
): Promise<boolean> {
  if (canPersist && !canPersist()) return false;
  await ensureSecureDir(authDir());
  if (canPersist && !canPersist()) return false;
  const encoded = encodePayload(JSON.stringify(tokens));
  if (canPersist && !canPersist()) return false;
  await writeSecureFile(path, encoded);
  return true;
}

/** Persist tokens (encrypted when available). */
export async function saveGoogleTokens(
  tokens: Omit<GoogleTokenFileV1, "authSchemaVersion" | "clientId"> & {
    clientId?: string;
  },
  canPersist?: () => boolean,
): Promise<void> {
  const clientId = tokens.clientId ?? getGoogleOAuthClientId();
  if (clientId.length === 0) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID is not configured");
  }

  const payload: GoogleTokenFileV1 = {
    authSchemaVersion: GOOGLE_AUTH_SCHEMA_VERSION,
    clientId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiryMs: tokens.expiryMs,
    ...(tokens.email !== undefined ? { email: tokens.email } : {}),
    ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
  };

  const path = tokenPath();
  await serializeMutation(path, async () => {
    await persistTokens(path, payload, canPersist);
  });
}

export async function saveGoogleTokensIfCurrent(
  expected: GoogleTokenFileV1,
  next: GoogleTokenFileV1,
  isLive?: () => boolean,
): Promise<boolean> {
  const path = tokenPath();
  return serializeMutation(path, async () => {
    if (!(await currentTokensMatch(path, expected))) return false;
    return persistTokens(path, next, isLive);
  });
}

export async function clearGoogleTokensIfCurrent(
  expected: GoogleTokenFileV1,
  isLive?: () => boolean,
): Promise<boolean> {
  const path = tokenPath();
  return serializeMutation(path, async () => {
    if (!(await currentTokensMatch(path, expected))) return false;
    if (isLive && !isLive()) return false;
    await unlink(path);
    return true;
  });
}

/** Delete token file if present. */
export async function clearGoogleTokens(): Promise<void> {
  const path = tokenPath();
  await serializeMutation(path, async () => {
    try {
      await unlink(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  });
}
