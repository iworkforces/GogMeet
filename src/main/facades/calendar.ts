import type { CalendarPublication } from "../../domain/entities/calendar-publication.js";
import type { CalendarPermission, CalendarResult } from "../../domain/entities/calendar-result.js";
import type { CalendarUiState } from "../../domain/entities/calendar-ui-state.js";
import { defaultCalendarUiState } from "../../domain/entities/calendar-ui-state.js";
import type { MeetingEvent } from "../../domain/entities/meeting-event.js";
import type { CalendarPort } from "../application/ports/calendar-port.js";
import type { EventPublisherPort } from "../application/ports/event-publisher-port.js";
import {
  createDisconnectCalendar,
  type DisconnectCalendar,
} from "../application/use-cases/disconnect-calendar.js";
import {
  createGetCalendarPermissionStatus,
  type GetCalendarPermissionStatus,
} from "../application/use-cases/get-calendar-permission-status.js";
import { createGetMeetings, type GetMeetings } from "../application/use-cases/get-meetings.js";
import {
  createRequestCalendarAccess,
  type RequestCalendarAccess,
} from "../application/use-cases/request-calendar-access.js";
import type { CalendarProvider } from "../calendar/provider.js";
import { getActiveCalendarProvider, resetCalendarProvider } from "../calendar/factory.js";
import { createCalendarRefreshCoordinator } from "../calendar/refresh-coordinator.js";
import { mainBus } from "../events.js";
import { isDarwin } from "../platform/os.js";

export interface CalendarFacadeDependencies {
  readonly resolveProvider?: () => Promise<CalendarProvider>;
  readonly resetProvider?: () => void;
  readonly publisher?: EventPublisherPort;
  readonly isDarwin?: () => boolean;
}

export interface CalendarFacade {
  readonly getCalendarUiState: () => CalendarUiState;
  readonly refreshCalendarPublication: () => Promise<CalendarPublication>;
  readonly getCalendarEventsResult: () => Promise<CalendarResult>;
  readonly getLastPublication: () => CalendarPublication | null;
  readonly cancelActiveCalendarRefresh: () => void;
  readonly requestCalendarPermission: () => Promise<CalendarPermission>;
  readonly getCalendarPermissionStatus: () => Promise<CalendarPermission>;
  readonly invalidateCalendarPermissionCache: () => void;
  readonly shouldAutoRequestCalendarPermission: () => boolean;
  readonly warmupCalendarProvider: () => Promise<void>;
  readonly disconnectCalendar: () => Promise<void>;
  readonly reportCalendarPollError: (error: string, lastEvents: MeetingEvent[] | null) => void;
  readonly getCalendarPort: () => Promise<CalendarPort>;
}

class CalendarProviderLifecycleInvalidatedError extends Error {
  constructor() {
    super("Calendar provider lifecycle invalidated");
    this.name = "CalendarProviderLifecycleInvalidatedError";
  }
}

interface PendingProviderResolution {
  readonly generation: number;
  readonly promise: Promise<CalendarProvider>;
}

function asCalendarPort(provider: CalendarProvider): CalendarPort {
  const port: CalendarPort = {
    getEvents: (signal) => provider.getEvents(signal),
    getPermissionStatus: () => provider.getPermissionStatus(),
    requestPermission: () => provider.requestPermission(),
  };
  if (provider.startWatch) port.startWatch = provider.startWatch.bind(provider);
  if (provider.stopWatch) port.stopWatch = provider.stopWatch.bind(provider);
  if (provider.disconnect) port.disconnect = provider.disconnect.bind(provider);
  if (provider.warmup) port.warmup = provider.warmup.bind(provider);
  if (provider.getAccountLabel) port.getAccountLabel = provider.getAccountLabel.bind(provider);
  if (provider.isOAuthConfigured) {
    port.isOAuthConfigured = provider.isOAuthConfigured.bind(provider);
  }
  if (provider.isOAuthInFlight) port.isOAuthInFlight = provider.isOAuthInFlight.bind(provider);
  if (provider.reviveWatch) port.reviveWatch = provider.reviveWatch.bind(provider);
  return port;
}

export function createCalendarFacade(
  dependencies: CalendarFacadeDependencies = {},
): CalendarFacade {
  const resolveProviderDependency = dependencies.resolveProvider ?? getActiveCalendarProvider;
  const resetProviderDependency = dependencies.resetProvider ?? resetCalendarProvider;
  const isDarwinDependency = dependencies.isDarwin ?? isDarwin;
  const publisher: EventPublisherPort = dependencies.publisher ?? {
    publishCalendarStatus: (state) => mainBus.emit("calendar-status-updated", state),
  };

  let cachedPermissionStatus: CalendarPermission | null = null;
  let uiState = defaultCalendarUiState();
  let cachedProvider: CalendarProvider | null = null;
  let pendingProviderResolution: PendingProviderResolution | null = null;
  let calendarPort: CalendarPort | null = null;
  let getMeetings: GetMeetings | null = null;
  let requestAccess: RequestCalendarAccess | null = null;
  let permissionStatus: GetCalendarPermissionStatus | null = null;
  let disconnect: DisconnectCalendar | null = null;
  let providerLifecycleGeneration = 0;
  let permissionLifecycleController = new AbortController();

  function setUiState(partial: Partial<CalendarUiState>): void {
    uiState = { ...uiState, ...partial };
  }

  async function resolveProvider(): Promise<CalendarProvider> {
    if (cachedProvider !== null) return cachedProvider;

    const lifecycleGeneration = providerLifecycleGeneration;
    let pendingResolution = pendingProviderResolution;
    if (pendingResolution === null || pendingResolution.generation !== lifecycleGeneration) {
      pendingResolution = {
        generation: lifecycleGeneration,
        promise: resolveProviderDependency(),
      };
      pendingProviderResolution = pendingResolution;
    }

    try {
      const provider = await pendingResolution.promise;
      if (providerLifecycleGeneration !== pendingResolution.generation) {
        throw new CalendarProviderLifecycleInvalidatedError();
      }
      cachedProvider = provider;
      return provider;
    } finally {
      if (pendingProviderResolution === pendingResolution) {
        pendingProviderResolution = null;
      }
    }
  }

  function resetPermissionLifecycle(): void {
    permissionLifecycleController.abort(new CalendarProviderLifecycleInvalidatedError());
    permissionLifecycleController = new AbortController();
  }

  function getLazyCalendarPort(): CalendarPort {
    if (calendarPort !== null) return calendarPort;
    calendarPort = {
      getEvents: async (signal) => asCalendarPort(await resolveProvider()).getEvents(signal),
      getPermissionStatus: async () =>
        asCalendarPort(await resolveProvider()).getPermissionStatus(),
      requestPermission: async () => asCalendarPort(await resolveProvider()).requestPermission(),
      disconnect: async () => asCalendarPort(await resolveProvider()).disconnect?.(),
      warmup: async () => asCalendarPort(await resolveProvider()).warmup?.(),
      getAccountLabel: async () =>
        (await asCalendarPort(await resolveProvider()).getAccountLabel?.()) ?? null,
      isOAuthConfigured: () => cachedProvider?.isOAuthConfigured?.() ?? false,
      isOAuthInFlight: () => cachedProvider?.isOAuthInFlight?.() ?? false,
    };
    return calendarPort;
  }

  function getMeetingsUseCase(): GetMeetings {
    getMeetings ??= createGetMeetings({
      calendar: getLazyCalendarPort(),
      publisher,
      getUiState: () => uiState,
      setUiState,
      setCachedPermission: (status) => {
        cachedPermissionStatus = status;
      },
    });
    return getMeetings;
  }

  function getRequestAccessUseCase(): RequestCalendarAccess {
    requestAccess ??= createRequestCalendarAccess({
      calendar: getLazyCalendarPort(),
      publisher,
      getUiState: () => uiState,
      setUiState,
      setCachedPermission: (status) => {
        cachedPermissionStatus = status;
      },
    });
    return requestAccess;
  }

  function getPermissionStatusUseCase(): GetCalendarPermissionStatus {
    permissionStatus ??= createGetCalendarPermissionStatus({
      calendar: getLazyCalendarPort(),
      publisher,
      getCachedPermission: () => cachedPermissionStatus,
      setCachedPermission: (status) => {
        cachedPermissionStatus = status;
      },
      getUiState: () => uiState,
      setUiState,
    });
    return permissionStatus;
  }

  function getDisconnectUseCase(): DisconnectCalendar {
    disconnect ??= createDisconnectCalendar({
      calendar: getLazyCalendarPort(),
      publisher,
      resetProvider: () => {
        resetPermissionLifecycle();
        providerLifecycleGeneration += 1;
        cachedProvider = null;
        resetProviderDependency();
      },
      setCachedPermission: (status) => {
        cachedPermissionStatus = status;
      },
      setUiState: (state) => {
        uiState = state;
      },
    });
    return disconnect;
  }

  const refreshCoordinator = createCalendarRefreshCoordinator((signal) =>
    getMeetingsUseCase().execute(signal),
  );

  async function disconnectCalendar(): Promise<void> {
    refreshCoordinator.cancel();
    resetPermissionLifecycle();
    providerLifecycleGeneration += 1;
    await getDisconnectUseCase().execute();
  }

  return {
    getCalendarUiState: () => uiState,
    refreshCalendarPublication: () => refreshCoordinator.requestRefresh(),
    getCalendarEventsResult: async () => (await refreshCoordinator.requestRefresh()).result,
    getLastPublication: () => refreshCoordinator.getLastPublication(),
    cancelActiveCalendarRefresh: () => refreshCoordinator.cancel(),
    requestCalendarPermission: () =>
      getRequestAccessUseCase().execute(permissionLifecycleController.signal),
    getCalendarPermissionStatus: () =>
      getPermissionStatusUseCase().execute(permissionLifecycleController.signal),
    invalidateCalendarPermissionCache: () => {
      cachedPermissionStatus = null;
    },
    shouldAutoRequestCalendarPermission: () => isDarwinDependency(),
    warmupCalendarProvider: async () => {
      await getLazyCalendarPort().warmup?.();
    },
    disconnectCalendar,
    reportCalendarPollError: (error, lastEvents) => {
      const hasRetainedEvents = lastEvents !== null && lastEvents.length > 0;
      setUiState({
        phase: hasRetainedEvents ? "offline-cached" : "error",
        lastError: error,
        events: lastEvents,
        offline: hasRetainedEvents,
        oauthConfigured: getLazyCalendarPort().isOAuthConfigured?.() ?? false,
        darwinPartialRefreshDiagnostics: null,
        cacheAgeMs: null,
      });
      publisher.publishCalendarStatus(uiState);
    },
    getCalendarPort: async () => asCalendarPort(await resolveProvider()),
  };
}
