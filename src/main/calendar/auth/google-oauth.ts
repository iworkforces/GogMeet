/**
 * Google Desktop OAuth PKCE with loopback redirect.
 * Bind 127.0.0.1 only; 5 minute timeout; single in-flight flow.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { shell } from "electron";
import { URL } from "node:url";

import { getGoogleOAuthClientId, isGoogleOAuthConfigured } from "./google-client-id.js";
import {
  clearGoogleTokensIfCurrent,
  loadGoogleTokensResult,
  saveGoogleTokens,
  saveGoogleTokensIfCurrent,
  type GoogleTokenFileV1,
} from "./google-token-store.js";
import {
  GoogleHttpError,
  googleHttpJson,
  googleHttpRequest,
  parseGoogleApiErrorCode,
} from "../google-http.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly", "openid", "email"] as const;

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const PROACTIVE_REFRESH_MS = 60_000;

export type GoogleRefreshMode = "if-needed" | "force";

export type GoogleTokenRefreshResult =
  | { kind: "ok"; tokens: GoogleTokenFileV1; didRefresh: boolean }
  | { kind: "no-tokens" }
  | { kind: "invalidated" }
  | {
      kind: "transient";
      reason:
        | "network"
        | "timeout"
        | "abort"
        | "rate-limit"
        | "server"
        | "protocol"
        | "storage"
        | "configuration";
    };

/** In-flight actual network refresh (never a pure cache hit). */
let refreshInFlight: Promise<GoogleTokenRefreshResult> | null = null;
/** Single forced follow-up when force joined an if-needed that did not refresh. */
let forceFollowUp: Promise<GoogleTokenRefreshResult> | null = null;
/** Lifecycle-level abort for shared OAuth transport (shutdown). */
let lifecycleAbort: AbortController = new AbortController();
let oauthInFlight: Promise<"granted" | "denied" | "not-determined"> | null = null;

/** Abort any in-flight shared token refresh (app shutdown). New calls get a fresh controller. */
export function abortGoogleTokenRefreshLifecycle(): void {
  lifecycleAbort.abort();
  lifecycleAbort = new AbortController();
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function generateVerifier(): string {
  return base64Url(randomBytes(32));
}

function generateChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function generateState(): string {
  return base64Url(randomBytes(16));
}

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee}
.card{max-width:28rem;padding:2rem;border-radius:12px;background:#1c1c1e;text-align:center}</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

async function exchangeCode(params: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
}): Promise<GoogleTokenFileV1> {
  const body = new URLSearchParams({
    code: params.code,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
    code_verifier: params.codeVerifier,
  });

  let json: Record<string, unknown>;
  try {
    json = (await googleHttpJson({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    })) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof GoogleHttpError) {
      throw new Error(
        err.apiErrorCode
          ? `Token exchange failed (${err.apiErrorCode})`
          : `Token exchange failed (${err.errorClass})`,
        { cause: err },
      );
    }
    throw err;
  }

  const accessToken = json["access_token"];
  const refreshToken = json["refresh_token"];
  const expiresIn = json["expires_in"];
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new Error("Token response missing access_token or refresh_token");
  }
  const expiryMs = Date.now() + (typeof expiresIn === "number" ? expiresIn * 1000 : 3600 * 1000);

  let email: string | undefined;
  try {
    const userRes = await googleHttpRequest({
      url: "https://www.googleapis.com/oauth2/v2/userinfo",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (userRes.ok) {
      const user = JSON.parse(userRes.bodyText) as Record<string, unknown>;
      if (typeof user["email"] === "string") email = user["email"];
    } else {
      void parseGoogleApiErrorCode(userRes.bodyText);
    }
  } catch {
    // email is optional
  }

  const scope = typeof json["scope"] === "string" ? json["scope"] : SCOPES.join(" ");
  return {
    authSchemaVersion: 1,
    clientId: params.clientId,
    accessToken,
    refreshToken,
    expiryMs,
    ...(email !== undefined ? { email } : {}),
    scope,
  };
}

function isDefinitiveAuthInvalidation(apiErrorCode: string | undefined): boolean {
  return apiErrorCode === "invalid_grant" || apiErrorCode === "invalid_token";
}

function mapHttpErrorToRefreshResult(err: GoogleHttpError): GoogleTokenRefreshResult {
  // OAuth token endpoint often returns 400 + invalid_grant — treat by code, not only 401/403.
  if (isDefinitiveAuthInvalidation(err.apiErrorCode)) {
    return { kind: "invalidated" };
  }
  switch (err.errorClass) {
    case "timeout":
      return { kind: "transient", reason: "timeout" };
    case "abort":
      return { kind: "transient", reason: "abort" };
    case "rate-limit":
      return { kind: "transient", reason: "rate-limit" };
    case "server":
      return { kind: "transient", reason: "server" };
    case "auth":
      // Non-definitive auth (e.g. 403) — treat as transient protocol/auth noise
      return { kind: "transient", reason: "protocol" };
    case "protocol":
    case "payload-too-large":
      return { kind: "transient", reason: "protocol" };
    case "network":
    default:
      return { kind: "transient", reason: "network" };
  }
}

async function performNetworkRefresh(
  tokens: GoogleTokenFileV1,
  signal: AbortSignal,
): Promise<GoogleTokenRefreshResult> {
  const clientId = getGoogleOAuthClientId();
  if (clientId.length === 0) {
    return { kind: "transient", reason: "configuration" };
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  });

  // Shared refresh is bounded by its own 15s transport deadline + lifecycle abort.
  // Caller/poll abort must not cancel the shared flight (only the waiter).
  let json: Record<string, unknown>;
  try {
    json = (await googleHttpJson({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal,
    })) as Record<string, unknown>;
  } catch (err) {
    if (signal.aborted) return { kind: "transient", reason: "abort" };
    if (err instanceof GoogleHttpError) {
      const mapped = mapHttpErrorToRefreshResult(err);
      if (mapped.kind === "invalidated") {
        try {
          const cleared = await clearGoogleTokensIfCurrent(tokens, () => !signal.aborted);
          if (signal.aborted) return { kind: "transient", reason: "abort" };
          if (!cleared) return { kind: "transient", reason: "storage" };
          console.warn("[calendar:auth] Refresh invalidated grant; clearing tokens");
        } catch (storageError) {
          console.warn(
            "[calendar:auth] Refresh invalidated grant but clearing failed:",
            storageError,
          );
          return { kind: "transient", reason: "storage" };
        }
      } else {
        console.warn("[calendar:auth] Refresh failed (credentials preserved):", err.errorClass);
      }
      return mapped;
    }
    console.warn("[calendar:auth] Refresh failed (credentials preserved):", err);
    return { kind: "transient", reason: "network" };
  }

  if (signal.aborted) return { kind: "transient", reason: "abort" };

  const accessToken = json["access_token"];
  const expiresIn = json["expires_in"];
  if (typeof accessToken !== "string") {
    return { kind: "transient", reason: "protocol" };
  }

  const next: GoogleTokenFileV1 = {
    ...tokens,
    clientId,
    accessToken,
    expiryMs: Date.now() + (typeof expiresIn === "number" ? expiresIn * 1000 : 3600 * 1000),
    // Google may omit refresh_token on refresh — keep existing
    refreshToken:
      typeof json["refresh_token"] === "string" ? json["refresh_token"] : tokens.refreshToken,
  };

  try {
    const saved = await saveGoogleTokensIfCurrent(tokens, next, () => !signal.aborted);
    if (signal.aborted) return { kind: "transient", reason: "abort" };
    if (!saved) return { kind: "transient", reason: "storage" };
  } catch (err) {
    console.warn(
      "[calendar:auth] Refresh succeeded but persistence failed; discarding unpersisted token:",
      err,
    );
    // Prior ciphertext left untouched by failed write.
    return { kind: "transient", reason: "storage" };
  }

  if (signal.aborted) return { kind: "transient", reason: "abort" };

  return { kind: "ok", tokens: next, didRefresh: true };
}

/**
 * Start or join a network refresh flight. Always performs a real token refresh
 * when tokens are present (caller decides if-needed vs force before calling).
 */
function startRefreshFlight(tokens: GoogleTokenFileV1): Promise<GoogleTokenRefreshResult> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = performNetworkRefresh(tokens, lifecycleAbort.signal).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function runForceFollowUp(): Promise<GoogleTokenRefreshResult> {
  if (forceFollowUp) return forceFollowUp;

  const signal = lifecycleAbort.signal;

  const flight = (async (): Promise<GoogleTokenRefreshResult> => {
    // Wait for any active if-needed/network flight to finish first.
    if (refreshInFlight) {
      try {
        await refreshInFlight;
      } catch {
        // ignore
      }
    }
    if (signal.aborted) return { kind: "transient", reason: "abort" };
    const loaded = await loadGoogleTokensResult();
    if (signal.aborted) return { kind: "transient", reason: "abort" };
    if (loaded.kind !== "ok") {
      return loaded.reason === "missing"
        ? { kind: "no-tokens" }
        : { kind: "transient", reason: "storage" };
    }
    return startRefreshFlight(loaded.tokens);
  })().finally(() => {
    forceFollowUp = null;
  });
  forceFollowUp = flight;
  return flight;
}

/**
 * Race a shared result against a caller AbortSignal without cancelling the shared work.
 */
async function awaitSharedWithCallerAbort(
  shared: Promise<GoogleTokenRefreshResult>,
  callerSignal?: AbortSignal,
): Promise<GoogleTokenRefreshResult> {
  if (!callerSignal) return shared;
  if (callerSignal.aborted) {
    return { kind: "transient", reason: "abort" };
  }
  return await new Promise<GoogleTokenRefreshResult>((resolve) => {
    const onAbort = (): void => {
      cleanup();
      resolve({ kind: "transient", reason: "abort" });
    };
    const cleanup = (): void => {
      callerSignal.removeEventListener("abort", onAbort);
    };
    callerSignal.addEventListener("abort", onAbort, { once: true });
    void shared.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      () => {
        cleanup();
        resolve({ kind: "transient", reason: "network" });
      },
    );
  });
}

/**
 * Typed token refresh with if-needed | force modes.
 * - if-needed: returns cached tokens when still fresh; otherwise single-flight refresh
 * - force: always performs a real refresh; joins an in-flight network refresh; if the
 *   concurrent if-needed path only returned a cache hit, enqueues one forced follow-up
 * Clears credentials only on definitive invalid_grant / invalid_token.
 */
export async function refreshGoogleAccessToken(
  mode: GoogleRefreshMode = "if-needed",
  callerSignal?: AbortSignal,
): Promise<GoogleTokenRefreshResult> {
  const requestLifecycle = lifecycleAbort.signal;
  if (mode === "force") {
    if (refreshInFlight) {
      const joined = await awaitSharedWithCallerAbort(refreshInFlight, callerSignal);
      if (joined.kind === "ok" && joined.didRefresh) {
        return joined;
      }
      if (
        joined.kind === "transient" &&
        joined.reason === "abort" &&
        (callerSignal?.aborted || requestLifecycle.aborted)
      ) {
        return joined;
      }
      if (requestLifecycle.aborted) return { kind: "transient", reason: "abort" };
      // In-flight was not a successful refresh for this force caller — one follow-up.
      return awaitSharedWithCallerAbort(runForceFollowUp(), callerSignal);
    }

    if (forceFollowUp) {
      return awaitSharedWithCallerAbort(forceFollowUp, callerSignal);
    }

    const loaded = await loadGoogleTokensResult();
    if (requestLifecycle.aborted) return { kind: "transient", reason: "abort" };
    if (loaded.kind !== "ok") {
      if (loaded.reason === "missing") return { kind: "no-tokens" };
      return { kind: "transient", reason: "storage" };
    }
    return awaitSharedWithCallerAbort(startRefreshFlight(loaded.tokens), callerSignal);
  }

  // if-needed
  const loaded = await loadGoogleTokensResult();
  if (requestLifecycle.aborted) return { kind: "transient", reason: "abort" };
  if (loaded.kind !== "ok") {
    if (loaded.reason === "missing") return { kind: "no-tokens" };
    return { kind: "transient", reason: "storage" };
  }

  if (loaded.tokens.expiryMs - Date.now() > PROACTIVE_REFRESH_MS) {
    // Cache hit — no network. Concurrent force callers must not treat this as a refresh.
    return { kind: "ok", tokens: loaded.tokens, didRefresh: false };
  }

  if (refreshInFlight) {
    return awaitSharedWithCallerAbort(refreshInFlight, callerSignal);
  }

  return awaitSharedWithCallerAbort(startRefreshFlight(loaded.tokens), callerSignal);
}

/**
 * Convenience wrapper: returns usable tokens or null.
 * Does not clear credentials on transient failures.
 * @param mode if-needed (default) or force
 */
export async function ensureFreshGoogleAccessToken(
  mode: GoogleRefreshMode = "if-needed",
  callerSignal?: AbortSignal,
): Promise<GoogleTokenFileV1 | null> {
  const result = await refreshGoogleAccessToken(mode, callerSignal);
  return result.kind === "ok" ? result.tokens : null;
}

/**
 * Run interactive PKCE OAuth in the system browser.
 * Returns granted/denied/not-determined; coalesces concurrent calls.
 */
export async function runGooglePkceLogin(): Promise<"granted" | "denied" | "not-determined"> {
  if (oauthInFlight) return oauthInFlight;

  const signal = lifecycleAbort.signal;
  oauthInFlight = (async () => {
    if (!isGoogleOAuthConfigured()) {
      console.error("[calendar:auth] GOOGLE_OAUTH_CLIENT_ID is not set");
      return "denied";
    }

    const clientId = getGoogleOAuthClientId();
    const codeVerifier = generateVerifier();
    const codeChallenge = generateChallenge(codeVerifier);
    const state = generateState();

    let server: Server | null = null;
    let activeResponse: ServerResponse | null = null;
    let settled = false;
    const isLive = (): boolean => !settled && !signal.aborted;

    const result = await new Promise<"granted" | "denied" | "not-determined">((resolve) => {
      const finish = (value: "granted" | "denied" | "not-determined"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (activeResponse && !activeResponse.writableEnded) {
          activeResponse.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          activeResponse.end(htmlPage("Connection cancelled", "Return to GogMeet and try again."));
        }
        activeResponse = null;
        if (server) {
          server.close();
          server = null;
        }
        resolve(value);
      };

      const timer = setTimeout(() => {
        console.warn("[calendar:auth] OAuth timed out");
        finish("not-determined");
      }, OAUTH_TIMEOUT_MS);
      const onAbort = (): void => finish("not-determined");
      signal.addEventListener("abort", onAbort, { once: true });

      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          try {
            if (!req.url) {
              res.writeHead(400);
              res.end("Bad request");
              return;
            }
            const url = new URL(req.url, "http://127.0.0.1");
            if (url.pathname !== "/oauth/callback") {
              res.writeHead(404);
              res.end("Not found");
              return;
            }

            const errParam = url.searchParams.get("error");
            if (errParam) {
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end(
                htmlPage(
                  "Authorization cancelled",
                  "You can close this window and return to GogMeet.",
                ),
              );
              finish("denied");
              return;
            }

            const code = url.searchParams.get("code");
            const returnedState = url.searchParams.get("state");
            if (!code || returnedState !== state) {
              res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
              res.end(htmlPage("Invalid response", "State mismatch or missing code."));
              finish("denied");
              return;
            }

            const addr = server?.address();
            if (!addr || typeof addr === "string") {
              finish("denied");
              return;
            }
            const redirectUri = `http://127.0.0.1:${addr.port}/oauth/callback`;

            try {
              activeResponse = res;
              const tokens = await exchangeCode({
                code,
                redirectUri,
                codeVerifier,
                clientId,
              });
              if (!isLive()) return;
              await saveGoogleTokens(tokens, isLive);
              if (!isLive()) return;
              activeResponse = null;
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end(
                htmlPage(
                  "Connected",
                  "Google Calendar is connected. You can close this window and return to GogMeet.",
                ),
              );
              finish("granted");
            } catch (exchangeErr) {
              if (!isLive()) return;
              console.error("[calendar:auth] Token exchange failed:", exchangeErr);
              activeResponse = null;
              res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
              res.end(
                htmlPage(
                  "Connection failed",
                  "Could not complete sign-in. Return to GogMeet and try again.",
                ),
              );
              finish("denied");
            }
          } catch (handlerErr) {
            console.error("[calendar:auth] Callback handler error:", handlerErr);
            try {
              res.writeHead(500);
              res.end("Error");
            } catch {
              // ignore
            }
            finish("denied");
          }
        })();
      });

      server.listen(0, "127.0.0.1", () => {
        if (!isLive()) return;
        const addr = server?.address();
        if (!addr || typeof addr === "string") {
          finish("denied");
          return;
        }
        const redirectUri = `http://127.0.0.1:${addr.port}/oauth/callback`;
        const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authUrl.searchParams.set("client_id", clientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", SCOPES.join(" "));
        authUrl.searchParams.set("access_type", "offline");
        authUrl.searchParams.set("prompt", "consent");
        authUrl.searchParams.set("code_challenge", codeChallenge);
        authUrl.searchParams.set("code_challenge_method", "S256");
        authUrl.searchParams.set("state", state);

        void shell.openExternal(authUrl.toString()).catch((openErr: unknown) => {
          console.error("[calendar:auth] Failed to open browser:", openErr);
          finish("denied");
        });
      });

      server.on("error", (listenErr) => {
        console.error("[calendar:auth] Loopback server error:", listenErr);
        finish("denied");
      });
    });

    return result;
  })().finally(() => {
    oauthInFlight = null;
  });

  return oauthInFlight;
}

/** Whether an OAuth browser flow is currently running. */
export function isGoogleOAuthInFlight(): boolean {
  return oauthInFlight !== null;
}
