/**
 * Encrypted per-calendar Google events.list nextSyncToken map.
 * Path: {userData}/calendar-auth/google-sync.enc
 * Does not store event bodies — only opaque sync tokens.
 */

import { app, safeStorage } from "electron";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isObjectRecord } from "../../../domain/entities/type-guards.js";
import { ensureSecureDir, writeSecureFile } from "../../utils/secure-fs.js";

export const GOOGLE_SYNC_SCHEMA_VERSION = 1 as const;

export interface GoogleSyncTokenFileV1 {
  readonly version: typeof GOOGLE_SYNC_SCHEMA_VERSION;
  /** calendarId → nextSyncToken from Google Calendar API */
  readonly tokens: Record<string, string>;
}

const pendingByPath = new Map<string, Promise<void>>();

function serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const result = (pendingByPath.get(path) ?? Promise.resolve()).then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  pendingByPath.set(path, settled);
  void settled.then(() => {
    if (pendingByPath.get(path) === settled) pendingByPath.delete(path);
  });
  return result;
}

function authDir(): string {
  return join(app.getPath("userData"), "calendar-auth");
}

function syncPath(): string {
  return join(authDir(), "google-sync.enc");
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function allowPlaintextDev(): boolean {
  return !app.isPackaged && process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] === "1";
}

function encode(json: string): Buffer {
  if (encryptionAvailable()) return safeStorage.encryptString(json);
  if (allowPlaintextDev()) return Buffer.from(json, "utf-8");
  throw new Error("OS secure storage unavailable for Google sync tokens");
}

function decode(buf: Buffer): string {
  if (encryptionAvailable()) return safeStorage.decryptString(buf);
  if (allowPlaintextDev()) return buf.toString("utf-8");
  throw new Error("OS secure storage unavailable for Google sync tokens");
}

async function readTokens(path: string): Promise<Record<string, string>> {
  try {
    const buf = await readFile(path);
    const parsed: unknown = JSON.parse(decode(buf));
    if (!isObjectRecord(parsed) || parsed["version"] !== GOOGLE_SYNC_SCHEMA_VERSION) {
      return {};
    }
    const tokens = parsed["tokens"];
    if (!isObjectRecord(tokens)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(tokens)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadGoogleSyncTokens(): Promise<Record<string, string>> {
  const path = syncPath();
  return serialize(path, () => readTokens(path));
}

async function writeTokens(
  path: string,
  tokens: Record<string, string>,
  isCurrent?: () => boolean,
): Promise<boolean> {
  await ensureSecureDir(authDir());
  if (isCurrent && !isCurrent()) return false;
  const payload: GoogleSyncTokenFileV1 = {
    version: GOOGLE_SYNC_SCHEMA_VERSION,
    tokens,
  };
  await writeSecureFile(path, encode(JSON.stringify(payload)));
  return true;
}

export function saveGoogleSyncTokens(tokens: Record<string, string>): Promise<void> {
  const path = syncPath();
  const snapshot = { ...tokens };
  return serialize(path, async () => {
    await writeTokens(path, snapshot);
  });
}

export function updateGoogleSyncToken(
  calendarId: string,
  tokenOrNull: string | null,
  isCurrent?: () => boolean,
): Promise<boolean> {
  const path = syncPath();
  return serialize(path, async () => {
    if (isCurrent && !isCurrent()) return false;
    const tokens = await readTokens(path);
    if (tokenOrNull === null) {
      if (!(calendarId in tokens)) return true;
      delete tokens[calendarId];
    } else {
      tokens[calendarId] = tokenOrNull;
    }
    return writeTokens(path, tokens, isCurrent);
  });
}

export async function clearGoogleSyncToken(calendarId: string): Promise<void> {
  await updateGoogleSyncToken(calendarId, null);
}

export function clearAllGoogleSyncTokens(): Promise<void> {
  const path = syncPath();
  return serialize(path, async () => {
    try {
      await unlink(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  });
}

export function googleSyncTokenFilePath(): string {
  return syncPath();
}
