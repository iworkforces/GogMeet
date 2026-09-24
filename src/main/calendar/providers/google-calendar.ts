/**
 * Google Calendar API provider (Windows MVP).
 * Maps API responses directly to MeetingEvent[] — no JSON Lines.
 */

import type {
  CalendarPermission,
  CalendarResult,
} from "../../../domain/entities/calendar-result.js";
import {
  calendarErr,
  calendarLiveOk,
  calendarOfflineOk,
} from "../../../domain/entities/calendar-result.js";
import type { MeetingEvent } from "../../../domain/entities/meeting-event.js";
import { asEventId, asIsoUtc } from "../../../domain/entities/brand.js";
import { formatAppError } from "../../../domain/entities/errors.js";
import { isObjectRecord } from "../../../domain/entities/type-guards.js";
import { cleanDescription } from "../../../domain/services/clean-description.js";
import { extractMeetingUrl } from "../../../domain/services/url-extract.js";
import { validateMeetUrl } from "../../../domain/services/url-validation.js";
import type { CalendarProvider } from "../provider.js";
import { clearGoogleTokens, loadGoogleTokens } from "../auth/google-token-store.js";
import {
  clearAllGoogleSyncTokens,
  loadGoogleSyncTokens,
  updateGoogleSyncToken,
} from "../auth/google-sync-tokens.js";
import {
  abortGoogleTokenRefreshLifecycle,
  ensureFreshGoogleAccessToken,
  isGoogleOAuthInFlight,
  refreshGoogleAccessToken,
  runGooglePkceLogin,
} from "../auth/google-oauth.js";
import { isGoogleOAuthConfigured } from "../auth/google-client-id.js";
import { clearOfflineCache, loadOfflineCache, saveOfflineCache } from "../offline-cache.js";
import {
  createPollBudgetSignal,
  GOOGLE_POLL_BUDGET_MS,
  GoogleHttpError,
  googleHttpRequest,
} from "../google-http.js";

const MAX_PAGES = 50;

type SyncPair = {
  readonly token: string;
  readonly events: Map<string, MeetingEvent>;
  readonly timeMin: string;
  readonly timeMax: string;
  readonly timezone: string;
  readonly account: string;
};

const workingPairs = new Map<string, SyncPair>();
let lifecycleGeneration = 0;
let pollRevision = 0;
let disconnectBarrier: Promise<void> = Promise.resolve();

/** Internal page-chain outcome: complete vs hit MAX_PAGES with more pages remaining. */
type TraversalStatus = "complete" | "pagination-limit";

class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/** Thrown when a bounded Google page chain still has a nextPageToken after MAX_PAGES. */
class PaginationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaginationLimitError";
  }
}

class TokenPersistenceError extends Error {
  constructor() {
    super("Google sync token persistence failed");
    this.name = "TokenPersistenceError";
  }
}

/** HTTP 429 — distinct from generic NetworkError so incremental paths skip full-window retry. */
class RateLimitError extends Error {
  constructor(message: string = "Google API rate limited (429)") {
    super(message);
    this.name = "RateLimitError";
  }
}

function dayBoundsLocal(): { timeMin: string; timeMax: string; timezone: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 2);
  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

type PollContext = {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly account: string;
  readonly window: ReturnType<typeof dayBoundsLocal>;
};

function requireCurrent(context: PollContext): void {
  if (!context.isCurrent()) throw new NetworkError("Google calendar poll cancelled");
}

async function persistToken(
  calendarId: string,
  token: string | null,
  context: PollContext,
): Promise<void> {
  try {
    const saved = await updateGoogleSyncToken(calendarId, token, context.isCurrent);
    requireCurrent(context);
    if (!saved) throw new TokenPersistenceError();
  } catch {
    requireCurrent(context);
    throw new TokenPersistenceError();
  }
}

async function googleFetch(
  url: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<{ ok: true; json: unknown } | { ok: false; status: number; body: string }> {
  try {
    const res = await googleHttpRequest({
      url,
      headers: { Authorization: `Bearer ${accessToken}` },
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) {
      // Do not propagate raw bodies upward for logging — keep a short redacted stub.
      return { ok: false, status: res.status, body: `http ${res.status}` };
    }
    try {
      return { ok: true, json: JSON.parse(res.bodyText) as unknown };
    } catch {
      return { ok: false, status: res.status, body: "invalid JSON" };
    }
  } catch (err) {
    if (err instanceof GoogleHttpError) {
      if (err.errorClass === "auth") {
        throw new AuthError(err.message);
      }
      if (err.errorClass === "rate-limit") {
        throw new RateLimitError(err.message);
      }
      throw new NetworkError(err.message);
    }
    throw err;
  }
}

async function listSelectedCalendarIds(
  accessToken: string,
  signal?: AbortSignal,
): Promise<{ status: TraversalStatus; calendarIds: string[] }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let status: TraversalStatus = "complete";

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const result = await googleFetch(url.toString(), accessToken, signal);
    if (!result.ok) {
      if (result.status === 401) throw new AuthError(result.body);
      if (result.status === 429) throw new RateLimitError(`calendarList rate limited (429)`);
      throw new NetworkError(`calendarList failed (${result.status})`);
    }
    if (!isObjectRecord(result.json) || !Array.isArray(result.json["items"])) {
      status = "pagination-limit";
      break;
    }

    for (const item of result.json["items"]) {
      if (!isObjectRecord(item)) continue;
      const id = item["id"];
      if (typeof id !== "string") continue;
      if (item["selected"] === true || item["primary"] === true) {
        ids.push(id);
      }
    }

    const next = result.json["nextPageToken"];
    if (typeof next !== "string" || next.length === 0) {
      status = "complete";
      break;
    }
    pageToken = next;
    // Last allowed page still advertises more → incomplete traversal.
    if (page === MAX_PAGES - 1) {
      status = "pagination-limit";
    }
  }

  if (ids.length === 0) {
    ids.push("primary");
  }
  return { status, calendarIds: [...new Set(ids)] };
}

function parseGoogleEventDate(value: string, allDay: boolean): string | null {
  const calendarDate = allDay ? value : value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(calendarDate)) return null;
  const midnight = new Date(`${calendarDate}T00:00:00.000Z`);
  if (
    !Number.isFinite(midnight.getTime()) ||
    midnight.toISOString().slice(0, 10) !== calendarDate
  ) {
    return null;
  }
  const date = allDay ? midnight : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function mapGoogleEvent(
  raw: unknown,
  calendarId: string,
  calendarName: string,
  userEmail: string | undefined,
): MeetingEvent | null {
  if (!isObjectRecord(raw)) return null;
  if (raw["status"] === "cancelled") return null;

  const attendees = raw["attendees"];
  if (Array.isArray(attendees)) {
    for (const a of attendees) {
      if (isObjectRecord(a) && a["self"] === true && a["responseStatus"] === "declined") {
        return null;
      }
    }
  }

  const idRaw = raw["id"];
  if (typeof idRaw !== "string") return null;
  const title = typeof raw["summary"] === "string" ? raw["summary"] : "(No title)";

  const startObj = isObjectRecord(raw["start"]) ? raw["start"] : null;
  const endObj = isObjectRecord(raw["end"]) ? raw["end"] : null;
  if (!startObj || !endObj) return null;

  let isAllDay = false;
  let startIso: string | null;
  let endIso: string | null;

  if (typeof startObj["dateTime"] === "string" && typeof endObj["dateTime"] === "string") {
    startIso = parseGoogleEventDate(startObj["dateTime"], false);
    endIso = parseGoogleEventDate(endObj["dateTime"], false);
  } else if (typeof startObj["date"] === "string" && typeof endObj["date"] === "string") {
    isAllDay = true;
    startIso = parseGoogleEventDate(startObj["date"], true);
    endIso = parseGoogleEventDate(endObj["date"], true);
  } else {
    return null;
  }
  if (startIso === null || endIso === null) return null;

  const startBrand = asIsoUtc(startIso);
  const endBrand = asIsoUtc(endIso);
  const idBrand = asEventId(`${calendarId}:${idRaw}`);
  if (!startBrand.ok || !endBrand.ok || !idBrand.ok) return null;

  const hangout = typeof raw["hangoutLink"] === "string" ? raw["hangoutLink"] : undefined;
  const location = typeof raw["location"] === "string" ? raw["location"] : undefined;
  const descriptionRaw = typeof raw["description"] === "string" ? raw["description"] : undefined;
  // Extract join URLs from raw HTML descriptions before tag stripping (href-only links).
  const description = descriptionRaw !== undefined ? cleanDescription(descriptionRaw) : undefined;

  const entryPoints: string[] = [];
  const conf = raw["conferenceData"];
  if (isObjectRecord(conf) && Array.isArray(conf["entryPoints"])) {
    for (const ep of conf["entryPoints"]) {
      if (isObjectRecord(ep) && typeof ep["uri"] === "string") {
        entryPoints.push(ep["uri"]);
      }
    }
  }

  const extracted = extractMeetingUrl(
    hangout,
    ...entryPoints,
    location,
    descriptionRaw,
    description,
  );
  let meetUrl: MeetingEvent["meetUrl"];
  if (extracted !== undefined) {
    const branded = validateMeetUrl(extracted);
    if (branded.ok) meetUrl = branded.value;
  }

  return {
    id: idBrand.value,
    title,
    startDate: startBrand.value,
    endDate: endBrand.value,
    calendarName,
    isAllDay,
    ...(meetUrl !== undefined ? { meetUrl } : {}),
    ...(userEmail !== undefined ? { userEmail } : {}),
    ...(description !== undefined && description.length > 0 ? { description } : {}),
  };
}

class GoneError extends Error {
  constructor() {
    super("sync token expired");
    this.name = "GoneError";
  }
}

async function fetchEventsFullWindow(
  accessToken: string,
  calendarId: string,
  calendarName: string,
  userEmail: string | undefined,
  window: ReturnType<typeof dayBoundsLocal> | undefined,
  signal?: AbortSignal,
): Promise<
  | { status: "complete"; events: MeetingEvent[]; nextSyncToken: string | undefined }
  | { status: "pagination-limit" }
  | { status: "malformed" }
> {
  const events: MeetingEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set("singleEvents", "true");
    if (window !== undefined) {
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("timeMin", window.timeMin);
      url.searchParams.set("timeMax", window.timeMax);
    }
    url.searchParams.set("conferenceDataVersion", "1");
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const result = await googleFetch(url.toString(), accessToken, signal);
    if (!result.ok) {
      if (result.status === 401) throw new AuthError(result.body);
      if (result.status === 429) throw new RateLimitError(`events.list rate limited (429)`);
      if (result.status === 403 || result.status === 404) {
        console.warn(`[calendar:google] Skipping calendar ${calendarId}: HTTP ${result.status}`);
        return { status: "complete", events: [], nextSyncToken: undefined };
      }
      throw new NetworkError(`events.list failed (${result.status})`);
    }

    if (!isObjectRecord(result.json) || !Array.isArray(result.json["items"])) {
      return { status: "malformed" };
    }

    for (const item of result.json["items"]) {
      const mapped = mapGoogleEvent(item, calendarId, calendarName, userEmail);
      if (mapped) events.push(mapped);
    }

    const next = result.json["nextPageToken"];
    if (typeof next === "string" && next.length > 0) {
      pageToken = next;
      if (page === MAX_PAGES - 1) {
        // Discard incomplete batch — do not authorize events or nextSyncToken.
        return { status: "pagination-limit" };
      }
      continue;
    }
    const sync = result.json["nextSyncToken"];
    if (typeof sync === "string" && sync.length > 0) nextSyncToken = sync;
    return { status: "complete", events, nextSyncToken };
  }

  return { status: "pagination-limit" };
}

/**
 * Incremental events.list using a stored nextSyncToken.
 * Throws GoneError on HTTP 410 so callers wipe the token and full-sync.
 */
async function fetchEventsIncremental(
  accessToken: string,
  calendarId: string,
  calendarName: string,
  userEmail: string | undefined,
  syncToken: string,
  signal?: AbortSignal,
): Promise<
  | {
      status: "complete";
      upserts: MeetingEvent[];
      deletedIds: string[];
      nextSyncToken: string | undefined;
    }
  | { status: "pagination-limit" }
> {
  const upserts: MeetingEvent[] = [];
  const deletedIds: string[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("conferenceDataVersion", "1");
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("syncToken", syncToken);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const result = await googleFetch(url.toString(), accessToken, signal);
    if (!result.ok) {
      if (result.status === 410) throw new GoneError();
      if (result.status === 401) throw new AuthError(result.body);
      if (result.status === 429) {
        // Preserve sync token + index; callers must not full-window retry this poll.
        throw new RateLimitError(`events.list incremental rate limited (429)`);
      }
      throw new NetworkError(`events.list incremental failed (${result.status})`);
    }
    if (!isObjectRecord(result.json) || !Array.isArray(result.json["items"])) {
      return { status: "pagination-limit" };
    }

    for (const item of result.json["items"]) {
      if (!isObjectRecord(item)) continue;
      const idRaw = item["id"];
      if (typeof idRaw !== "string") continue;
      const branded = asEventId(`${calendarId}:${idRaw}`);
      if (!branded.ok) continue;
      if (item["status"] === "cancelled") {
        deletedIds.push(branded.value);
        continue;
      }
      const mapped = mapGoogleEvent(item, calendarId, calendarName, userEmail);
      if (mapped) upserts.push(mapped);
      else deletedIds.push(branded.value);
    }

    const next = result.json["nextPageToken"];
    if (typeof next === "string" && next.length > 0) {
      pageToken = next;
      if (page === MAX_PAGES - 1) {
        // Discard incomplete upserts/deletes — prior index/token stay authoritative.
        return { status: "pagination-limit" };
      }
      continue;
    }
    const sync = result.json["nextSyncToken"];
    if (typeof sync === "string" && sync.length > 0) nextSyncToken = sync;
    return { status: "complete", upserts, deletedIds, nextSyncToken };
  }

  return { status: "pagination-limit" };
}

function filterEventsInWindow(
  events: MeetingEvent[],
  timeMin: string,
  timeMax: string,
): MeetingEvent[] {
  const minMs = new Date(timeMin).getTime();
  const maxMs = new Date(timeMax).getTime();
  return events.filter((e) => {
    if (e.isAllDay) {
      const startDay = new Date(e.startDate);
      const endDay = new Date(e.endDate);
      const localStart = new Date(
        startDay.getUTCFullYear(),
        startDay.getUTCMonth(),
        startDay.getUTCDate(),
      ).getTime();
      const localEnd = new Date(
        endDay.getUTCFullYear(),
        endDay.getUTCMonth(),
        endDay.getUTCDate(),
      ).getTime();
      return localEnd > minMs && localStart < maxMs;
    }
    const start = new Date(e.startDate).getTime();
    const end = new Date(e.endDate).getTime();
    return Number.isFinite(start) && Number.isFinite(end) && end > minMs && start < maxMs;
  });
}

async function fetchEventsForCalendar(
  accessToken: string,
  calendarId: string,
  calendarName: string,
  userEmail: string | undefined,
  context: PollContext,
): Promise<MeetingEvent[]> {
  requireCurrent(context);
  const stored = (await loadGoogleSyncTokens())[calendarId];
  requireCurrent(context);
  const pair = workingPairs.get(calendarId);
  const compatible =
    pair !== undefined &&
    stored === pair.token &&
    pair.timeMin === context.window.timeMin &&
    pair.timeMax === context.window.timeMax &&
    pair.timezone === context.window.timezone &&
    pair.account === context.account;

  if (compatible && pair !== undefined) {
    try {
      const inc = await fetchEventsIncremental(
        accessToken,
        calendarId,
        calendarName,
        userEmail,
        pair.token,
        context.signal,
      );
      requireCurrent(context);
      if (inc.status === "pagination-limit") {
        // Preserve index + stored nextSyncToken; do not apply incomplete upserts/deletes.
        throw new PaginationLimitError(
          `events.list incremental pagination limit for ${calendarId}`,
        );
      }
      const nextIndex = new Map(pair.events);
      for (const id of inc.deletedIds) nextIndex.delete(id);
      for (const event of inc.upserts) nextIndex.set(event.id, event);
      if (inc.nextSyncToken === undefined) {
        workingPairs.delete(calendarId);
        await persistToken(calendarId, null, context);
        return filterEventsInWindow(
          [...nextIndex.values()],
          context.window.timeMin,
          context.window.timeMax,
        );
      }
      workingPairs.delete(calendarId);
      await persistToken(calendarId, inc.nextSyncToken, context);
      workingPairs.set(calendarId, {
        token: inc.nextSyncToken,
        events: nextIndex,
        ...context.window,
        account: context.account,
      });
      return filterEventsInWindow(
        [...nextIndex.values()],
        context.window.timeMin,
        context.window.timeMax,
      );
    } catch (err) {
      if (err instanceof PaginationLimitError) {
        throw err;
      }
      if (err instanceof TokenPersistenceError) throw err;
      if (err instanceof RateLimitError) {
        // 429 must not amplify into a same-poll full-window request.
        throw err;
      }
      requireCurrent(context);
      if (err instanceof GoneError) {
        workingPairs.delete(calendarId);
        await persistToken(calendarId, null, context);
      } else if (err instanceof AuthError) {
        throw err;
      } else {
        // Incremental transport/5xx failure: fall back to full window for this poll.
        console.warn("[calendar:google] Incremental sync failed — full window fetch");
      }
    }
  }

  workingPairs.delete(calendarId);
  const full = await fetchEventsFullWindow(
    accessToken,
    calendarId,
    calendarName,
    userEmail,
    undefined,
    context.signal,
  );
  requireCurrent(context);
  if (full.status === "malformed") {
    throw new PaginationLimitError(`events.list malformed items for ${calendarId}`);
  }
  if (full.status === "pagination-limit") {
    const bounded = await fetchEventsFullWindow(
      accessToken,
      calendarId,
      calendarName,
      userEmail,
      context.window,
      context.signal,
    );
    requireCurrent(context);
    if (bounded.status !== "complete") {
      throw new PaginationLimitError(`events.list full pagination limit for ${calendarId}`);
    }
    await persistToken(calendarId, null, context);
    return filterEventsInWindow(bounded.events, context.window.timeMin, context.window.timeMax);
  }
  await persistToken(calendarId, full.nextSyncToken ?? null, context);
  if (full.nextSyncToken !== undefined) {
    workingPairs.set(calendarId, {
      token: full.nextSyncToken,
      events: new Map(full.events.map((event) => [event.id, event])),
      ...context.window,
      account: context.account,
    });
  }
  return filterEventsInWindow(full.events, context.window.timeMin, context.window.timeMax);
}

async function fetchAllEvents(
  accessToken: string,
  userEmail: string | undefined,
  context: PollContext,
): Promise<{ events: MeetingEvent[]; completeness: "complete" | "partial" }> {
  const list = await listSelectedCalendarIds(accessToken, context.signal);
  requireCurrent(context);
  const calendarIds = list.calendarIds;
  const listIncomplete = list.status === "pagination-limit";
  const merged: MeetingEvent[] = [];
  let successCount = 0;
  let failedCount = 0;
  let lastError: Error | null = null;

  for (const calendarId of calendarIds) {
    try {
      const batch = await fetchEventsForCalendar(
        accessToken,
        calendarId,
        calendarId,
        userEmail,
        context,
      );
      merged.push(...batch);
      successCount++;
    } catch (err) {
      requireCurrent(context);
      if (err instanceof AuthError) throw err;
      failedCount++;
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[calendar:google] Calendar ${calendarId} failed:`, lastError.message);
    }
  }
  requireCurrent(context);

  if (successCount === 0 && lastError) {
    throw lastError;
  }

  merged.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
  // All selected calendars fully traversed and calendar-list complete → complete.
  // Incomplete calendar-list, or any failed/pagination-limited calendar → partial.
  const completeness: "complete" | "partial" =
    !listIncomplete && failedCount === 0 && successCount === calendarIds.length
      ? "complete"
      : "partial";
  return { events: merged, completeness };
}

/**
 * Create the Google Calendar provider used on Windows (and non-Darwin auto).
 */
export function createGoogleCalendarProvider(): CalendarProvider {
  return {
    id: "google-calendar",

    async getEvents(upstreamSignal: AbortSignal): Promise<CalendarResult> {
      // 60 s overall poll budget for list + pages + await of refresh/retry.
      // Composed with upstream coordinator signal; does not cancel shared OAuth.
      const budget = createPollBudgetSignal(GOOGLE_POLL_BUDGET_MS, upstreamSignal);
      const generation = lifecycleGeneration;
      const revision = ++pollRevision;
      const isCurrent = (): boolean =>
        generation === lifecycleGeneration && revision === pollRevision && !budget.signal.aborted;
      try {
        await disconnectBarrier;
        if (!isCurrent()) throw new NetworkError("Google calendar poll cancelled");
        let tokens = await ensureFreshGoogleAccessToken("if-needed", budget.signal);
        if (!isCurrent()) throw new NetworkError("Google calendar poll cancelled");
        if (tokens === null) {
          return calendarErr(
            formatAppError({
              kind: "calendar-permission-denied",
              message: "Connect Google Calendar from the tray menu or Settings.",
            }),
            "permission-denied",
          );
        }
        const window = dayBoundsLocal();
        const context: PollContext = {
          signal: budget.signal,
          isCurrent,
          window,
          account: tokens.email ?? tokens.refreshToken ?? tokens.accessToken,
        };

        try {
          const { events, completeness } = await fetchAllEvents(
            tokens.accessToken,
            tokens.email,
            context,
          );
          requireCurrent(context);
          const observedAt = Date.now();
          // Only complete live snapshots may overwrite the encrypted cache.
          if (completeness === "complete") {
            await saveOfflineCache(events, observedAt, isCurrent);
          }
          requireCurrent(context);
          return calendarLiveOk(events, completeness, observedAt);
        } catch (err) {
          requireCurrent(context);
          if (err instanceof AuthError) {
            // API 401: force one real refresh, then one retry.
            const forced = await refreshGoogleAccessToken("force", budget.signal);
            requireCurrent(context);
            if (forced.kind !== "ok") {
              if (forced.kind === "invalidated" || forced.kind === "no-tokens") {
                return calendarErr(
                  formatAppError({
                    kind: "calendar-auth",
                    message: "Google session expired. Please reconnect.",
                  }),
                  "permission-denied",
                );
              }
              // transient refresh failure — try offline, do not clear
            } else {
              tokens = forced.tokens;
              const retryContext: PollContext = {
                ...context,
                account: tokens.email ?? tokens.refreshToken ?? tokens.accessToken,
              };
              try {
                const { events, completeness } = await fetchAllEvents(
                  tokens.accessToken,
                  tokens.email,
                  retryContext,
                );
                requireCurrent(retryContext);
                const observedAt = Date.now();
                if (completeness === "complete") {
                  await saveOfflineCache(events, observedAt, isCurrent);
                }
                requireCurrent(retryContext);
                return calendarLiveOk(events, completeness, observedAt);
              } catch (retryErr) {
                requireCurrent(retryContext);
                if (retryErr instanceof AuthError) {
                  await clearGoogleTokens();
                  requireCurrent(retryContext);
                  return calendarErr(
                    formatAppError({
                      kind: "calendar-auth",
                      message: "Google session expired. Please reconnect.",
                    }),
                    "permission-denied",
                  );
                }
                throw retryErr;
              }
            }
          }

          // Network / other / transient force-refresh: try offline cache
          // Empty filtered list is still offline success (display + explicit join).
          const cache = await loadOfflineCache();
          requireCurrent(context);
          if (cache !== null) {
            console.warn("[calendar:google] Network failure; using offline cache");
            return calendarOfflineOk(cache.events, cache.observedAt, cache.cachedAt);
          }

          const message = err instanceof Error ? err.message : String(err);
          return calendarErr(
            formatAppError({
              kind: "calendar-network",
              message: message || "Can't reach Google Calendar",
            }),
            "runtime",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[calendar:google] getEvents error:", err);
        return calendarErr(formatAppError({ kind: "calendar-runtime", message }), "runtime");
      } finally {
        budget.cleanup();
      }
    },

    async getPermissionStatus(): Promise<CalendarPermission> {
      if (isGoogleOAuthInFlight()) return "not-determined";
      if (!isGoogleOAuthConfigured()) return "denied";
      const tokens = await loadGoogleTokens();
      return tokens !== null ? "granted" : "not-determined";
    },

    async requestPermission(): Promise<CalendarPermission> {
      if (!isGoogleOAuthConfigured()) {
        console.error("[calendar:google] GOOGLE_OAUTH_CLIENT_ID is not configured");
        return "denied";
      }
      const result = await runGooglePkceLogin();
      if (result === "granted") return "granted";
      if (result === "denied") return "denied";
      return "not-determined";
    },

    async disconnect(): Promise<void> {
      lifecycleGeneration++;
      pollRevision++;
      workingPairs.clear();
      abortGoogleTokenRefreshLifecycle();
      const clear = async (): Promise<void> => {
        await clearGoogleTokens();
        await clearAllGoogleSyncTokens();
        await clearOfflineCache();
      };
      disconnectBarrier = disconnectBarrier.then(clear, clear);
      await disconnectBarrier;
    },

    async getAccountLabel(): Promise<string | null> {
      return (await loadGoogleTokens())?.email ?? null;
    },

    isOAuthConfigured(): boolean {
      return isGoogleOAuthConfigured();
    },

    isOAuthInFlight(): boolean {
      return isGoogleOAuthInFlight();
    },

    async warmup(): Promise<void> {
      // Soft-refresh tokens if present; ignore failures
      await ensureFreshGoogleAccessToken().catch(() => null);
    },
  };
}
