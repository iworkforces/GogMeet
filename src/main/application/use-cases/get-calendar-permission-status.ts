import type { CalendarPermission } from "../../../domain/entities/calendar-result.js";
import type { CalendarUiState } from "../../../domain/entities/calendar-ui-state.js";
import type { CalendarPort } from "../ports/calendar-port.js";
import type { EventPublisherPort } from "../ports/event-publisher-port.js";

export interface GetCalendarPermissionStatusDeps {
  calendar: CalendarPort;
  publisher: EventPublisherPort;
  getCachedPermission: () => CalendarPermission | null;
  setCachedPermission: (status: CalendarPermission) => void;
  getUiState: () => CalendarUiState;
  setUiState: (partial: Partial<CalendarUiState>) => void;
}

export interface GetCalendarPermissionStatus {
  execute(signal?: AbortSignal): Promise<CalendarPermission>;
}

const DEFAULT_SIGNAL = new AbortController().signal;

export function createGetCalendarPermissionStatus(
  deps: GetCalendarPermissionStatusDeps,
): GetCalendarPermissionStatus {
  return {
    async execute(signal: AbortSignal = DEFAULT_SIGNAL): Promise<CalendarPermission> {
      signal.throwIfAborted();
      if (deps.calendar.isOAuthInFlight?.()) return "not-determined";
      const cached = deps.getCachedPermission();
      if (cached !== null) return cached;

      const status = await deps.calendar.getPermissionStatus();
      signal.throwIfAborted();

      const ui = deps.getUiState();
      const accountEmail = (await deps.calendar.getAccountLabel?.()) ?? ui.accountEmail;
      signal.throwIfAborted();
      deps.setCachedPermission(status);
      const next: Partial<CalendarUiState> = {
        permission: status,
        phase:
          status === "granted"
            ? ui.events && ui.events.length > 0
              ? "ready"
              : "empty"
            : "disconnected",
        oauthConfigured: deps.calendar.isOAuthConfigured?.() ?? false,
        accountEmail,
        darwinPartialRefreshDiagnostics: null,
      };
      deps.setUiState(next);
      deps.publisher.publishCalendarStatus(deps.getUiState());

      return status;
    },
  };
}
