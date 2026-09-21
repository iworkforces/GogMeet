import { describe, expect, it, vi } from "vitest";
import type { CalendarPermission } from "../../src/domain/entities/calendar-result.js";
import { defaultCalendarUiState } from "../../src/domain/entities/calendar-ui-state.js";
import type { CalendarPort } from "../../src/main/application/ports/calendar-port.js";
import { createGetCalendarPermissionStatus } from "../../src/main/application/use-cases/get-calendar-permission-status.js";

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("createGetCalendarPermissionStatus", () => {
  it("does not perform provider or state work when already aborted", async () => {
    const getPermissionStatus = vi.fn().mockResolvedValue("granted");
    const setCachedPermission = vi.fn();
    const setUiState = vi.fn();
    const publishCalendarStatus = vi.fn();
    const useCase = createGetCalendarPermissionStatus({
      calendar: {
        getEvents: vi.fn(),
        getPermissionStatus,
        requestPermission: vi.fn(),
      },
      publisher: { publishCalendarStatus },
      getCachedPermission: () => null,
      setCachedPermission,
      getUiState: defaultCalendarUiState,
      setUiState,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(useCase.execute(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(getPermissionStatus).not.toHaveBeenCalled();
    expect(setCachedPermission).not.toHaveBeenCalled();
    expect(setUiState).not.toHaveBeenCalled();
    expect(publishCalendarStatus).not.toHaveBeenCalled();
  });

  it("does not mutate state when permission status resolves after cancellation", async () => {
    const deferred = createDeferred<CalendarPermission>();
    const getPermissionStatus = vi.fn(() => deferred.promise);
    const setCachedPermission = vi.fn();
    const setUiState = vi.fn();
    const publishCalendarStatus = vi.fn();
    const calendar: CalendarPort = {
      getEvents: vi.fn(),
      getPermissionStatus,
      requestPermission: vi.fn(),
    };
    const useCase = createGetCalendarPermissionStatus({
      calendar,
      publisher: { publishCalendarStatus },
      getCachedPermission: () => null,
      setCachedPermission,
      getUiState: defaultCalendarUiState,
      setUiState,
    });
    const controller = new AbortController();

    const execution = useCase.execute(controller.signal);
    controller.abort();
    deferred.resolve("granted");

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(setCachedPermission).not.toHaveBeenCalled();
    expect(setUiState).not.toHaveBeenCalled();
    expect(publishCalendarStatus).not.toHaveBeenCalled();
  });

  it("does not mutate state when account label resolves after cancellation", async () => {
    const deferred = createDeferred<string | null>();
    const getAccountLabel = vi.fn(() => deferred.promise);
    const setCachedPermission = vi.fn();
    const setUiState = vi.fn();
    const publishCalendarStatus = vi.fn();
    const calendar: CalendarPort = {
      getEvents: vi.fn(),
      getPermissionStatus: vi.fn().mockResolvedValue("granted"),
      requestPermission: vi.fn(),
      getAccountLabel,
    };
    const useCase = createGetCalendarPermissionStatus({
      calendar,
      publisher: { publishCalendarStatus },
      getCachedPermission: () => null,
      setCachedPermission,
      getUiState: defaultCalendarUiState,
      setUiState,
    });
    const controller = new AbortController();

    const execution = useCase.execute(controller.signal);
    await vi.waitFor(() => expect(getAccountLabel).toHaveBeenCalledOnce());
    controller.abort();
    deferred.resolve("stale@example.com");

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(setCachedPermission).not.toHaveBeenCalled();
    expect(setUiState).not.toHaveBeenCalled();
    expect(publishCalendarStatus).not.toHaveBeenCalled();
  });
});
