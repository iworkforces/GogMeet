import { describe, expect, it, vi } from "vitest";
import type { CalendarResult } from "../../src/domain/entities/calendar-result.js";
import { defaultCalendarUiState } from "../../src/domain/entities/calendar-ui-state.js";
import type { CalendarPort } from "../../src/main/application/ports/calendar-port.js";
import { createGetMeetings } from "../../src/main/application/use-cases/get-meetings.js";
import { createMockEvent } from "../helpers/test-utils.js";

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

describe("createGetMeetings cancellation", () => {
  it("does not project or publish when an AbortSignal-ignoring provider resolves after cancellation", async () => {
    const deferred = createDeferred<CalendarResult>();
    const getAccountLabel = vi.fn().mockResolvedValue("user@example.com");
    const calendar: CalendarPort = {
      getEvents: vi.fn(() => deferred.promise),
      getPermissionStatus: vi.fn(),
      requestPermission: vi.fn(),
      getAccountLabel,
      isOAuthConfigured: () => true,
    };
    let uiState = defaultCalendarUiState();
    const setUiState = vi.fn((partial) => {
      uiState = { ...uiState, ...partial };
    });
    const publishCalendarStatus = vi.fn();
    const setCachedPermission = vi.fn();
    const getMeetings = createGetMeetings({
      calendar,
      publisher: { publishCalendarStatus },
      getUiState: () => uiState,
      setUiState,
      setCachedPermission,
    });
    const controller = new AbortController();

    const execution = getMeetings.execute(controller.signal);
    controller.abort();
    deferred.resolve({
      kind: "ok",
      source: "live",
      completeness: "complete",
      observedAt: Date.now(),
      events: [createMockEvent()],
    });

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(getAccountLabel).not.toHaveBeenCalled();
    expect(setUiState).not.toHaveBeenCalled();
    expect(setCachedPermission).not.toHaveBeenCalled();
    expect(publishCalendarStatus).not.toHaveBeenCalled();
  });
});
