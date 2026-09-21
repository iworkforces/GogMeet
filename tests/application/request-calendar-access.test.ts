import { describe, expect, it, vi } from "vitest";
import type { CalendarPermission } from "../../src/domain/entities/calendar-result.js";
import { defaultCalendarUiState } from "../../src/domain/entities/calendar-ui-state.js";
import type { CalendarPort } from "../../src/main/application/ports/calendar-port.js";
import { createRequestCalendarAccess } from "../../src/main/application/use-cases/request-calendar-access.js";

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

describe("createRequestCalendarAccess", () => {
  it("does not mutate state when already aborted", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    const setUiState = vi.fn();
    const setCachedPermission = vi.fn();
    const publishCalendarStatus = vi.fn();
    const useCase = createRequestCalendarAccess({
      calendar: {
        getEvents: vi.fn(),
        getPermissionStatus: vi.fn(),
        requestPermission,
      },
      publisher: { publishCalendarStatus },
      getUiState: defaultCalendarUiState,
      setUiState,
      setCachedPermission,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(useCase.execute(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(setUiState).not.toHaveBeenCalled();
    expect(setCachedPermission).not.toHaveBeenCalled();
    expect(publishCalendarStatus).not.toHaveBeenCalled();
  });

  it("does not cache or publish when permission resolves after cancellation", async () => {
    const deferred = createDeferred<CalendarPermission>();
    const requestPermission = vi.fn(() => deferred.promise);
    const setUiState = vi.fn();
    const setCachedPermission = vi.fn();
    const publishCalendarStatus = vi.fn();
    const calendar: CalendarPort = {
      getEvents: vi.fn(),
      getPermissionStatus: vi.fn(),
      requestPermission,
    };
    const useCase = createRequestCalendarAccess({
      calendar,
      publisher: { publishCalendarStatus },
      getUiState: defaultCalendarUiState,
      setUiState,
      setCachedPermission,
    });
    const controller = new AbortController();

    const execution = useCase.execute(controller.signal);
    controller.abort();
    deferred.resolve("granted");

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(setUiState).toHaveBeenCalledOnce();
    expect(setCachedPermission).not.toHaveBeenCalled();
    expect(publishCalendarStatus).toHaveBeenCalledOnce();
  });

  it("does not cache or publish when account label resolves after cancellation", async () => {
    const deferred = createDeferred<string | null>();
    const getAccountLabel = vi.fn(() => deferred.promise);
    const setUiState = vi.fn();
    const setCachedPermission = vi.fn();
    const publishCalendarStatus = vi.fn();
    const calendar: CalendarPort = {
      getEvents: vi.fn(),
      getPermissionStatus: vi.fn(),
      requestPermission: vi.fn().mockResolvedValue("granted"),
      getAccountLabel,
    };
    const useCase = createRequestCalendarAccess({
      calendar,
      publisher: { publishCalendarStatus },
      getUiState: defaultCalendarUiState,
      setUiState,
      setCachedPermission,
    });
    const controller = new AbortController();

    const execution = useCase.execute(controller.signal);
    await vi.waitFor(() => expect(getAccountLabel).toHaveBeenCalledOnce());
    controller.abort();
    deferred.resolve("stale@example.com");

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(setUiState).toHaveBeenCalledOnce();
    expect(setCachedPermission).not.toHaveBeenCalled();
    expect(publishCalendarStatus).toHaveBeenCalledOnce();
  });
});
