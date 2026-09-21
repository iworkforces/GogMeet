import type { CalendarPermission } from "../../../domain/entities/calendar-result.js";
import type { CalendarUiState } from "../../../domain/entities/calendar-ui-state.js";
import type { CalendarPort } from "../ports/calendar-port.js";
import type { EventPublisherPort } from "../ports/event-publisher-port.js";

export interface RequestCalendarAccessDeps {
  calendar: CalendarPort;
  publisher: EventPublisherPort;
  getUiState: () => CalendarUiState;
  setUiState: (partial: Partial<CalendarUiState>) => void;
  setCachedPermission: (status: CalendarPermission) => void;
}

export interface RequestCalendarAccess {
  execute(signal?: AbortSignal): Promise<CalendarPermission>;
}

const DEFAULT_SIGNAL = new AbortController().signal;

export function createRequestCalendarAccess(
  deps: RequestCalendarAccessDeps,
): RequestCalendarAccess {
  return {
    async execute(signal: AbortSignal = DEFAULT_SIGNAL): Promise<CalendarPermission> {
      signal.throwIfAborted();
      const connecting: Partial<CalendarUiState> = {
        phase: "connecting",
        lastError: null,
        oauthConfigured: deps.calendar.isOAuthConfigured?.() ?? false,
        darwinPartialRefreshDiagnostics: null,
      };
      deps.setUiState(connecting);
      deps.publisher.publishCalendarStatus(deps.getUiState());

      const status = await deps.calendar.requestPermission();
      signal.throwIfAborted();

      if (status === "granted") {
        const email = (await deps.calendar.getAccountLabel?.()) ?? null;
        signal.throwIfAborted();
        deps.setCachedPermission(status);
        const next: Partial<CalendarUiState> = {
          permission: "granted",
          phase: "ready",
          lastError: null,
          accountEmail: email,
          oauthConfigured: deps.calendar.isOAuthConfigured?.() ?? false,
          darwinPartialRefreshDiagnostics: null,
        };
        deps.setUiState(next);
        deps.publisher.publishCalendarStatus(deps.getUiState());
      } else {
        deps.setCachedPermission(status);
        const next: Partial<CalendarUiState> = {
          permission: status,
          phase: status === "denied" ? "error" : "disconnected",
          lastError: status === "denied" ? "Google Calendar was not connected." : null,
          oauthConfigured: deps.calendar.isOAuthConfigured?.() ?? false,
          darwinPartialRefreshDiagnostics: null,
        };
        deps.setUiState(next);
        deps.publisher.publishCalendarStatus(deps.getUiState());
      }

      return status;
    },
  };
}
