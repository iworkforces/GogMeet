import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulerFacade } from "../../src/main/scheduler/facade.js";
import {
  clearSchedulerResources,
  createSchedulerState,
} from "../../src/main/scheduler/state/index.js";
import { showAlert } from "../../src/main/windows/alert-window.js";
import { schedulerTestContext } from "../helpers/scheduler-runtime.js";
import {
  asTestEventId,
  asTestIsoUtc,
  createMockEvent,
  createMockSettings,
  okCalendarResult,
} from "../helpers/test-utils.js";

vi.mock("../../src/main/windows/alert-window.js", () => ({ showAlert: vi.fn() }));

function restartFixture(windowAlert = false) {
  const now = Date.now();
  const event = createMockEvent({
    startDate: asTestIsoUtc(new Date(now + 61_000).toISOString()),
    endDate: asTestIsoUtc(new Date(now + 120_000).toISOString()),
  });
  const context = schedulerTestContext(createMockSettings({ openBeforeMinutes: 1, windowAlert }), {
    publicationGeneration: 1,
    result: okCalendarResult([event]),
  });
  return { context, event, facade: createSchedulerFacade(context.dependencies) };
}

describe("SchedulerFacade restart suppression", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(showAlert).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("preserves fired-event suppression", async () => {
    const { context, facade } = restartFixture();
    await facade.forcePoll({ reason: "user" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(context.open).toHaveBeenCalledOnce();

    facade.restart();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(context.open).toHaveBeenCalledOnce();
    facade.stop();
  });

  it("preserves alert-fired suppression", async () => {
    const { facade } = restartFixture(true);
    await facade.forcePoll({ reason: "user" });
    await vi.advanceTimersByTimeAsync(1);
    expect(showAlert).toHaveBeenCalledOnce();

    facade.restart();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1);

    expect(showAlert).toHaveBeenCalledOnce();
    facade.stop();
  });

  it("preserves title cancellation bookkeeping during resource cleanup", () => {
    const state = createSchedulerState();
    const id = asTestEventId("cancelled");
    state.cancelledEvents.add(id);

    clearSchedulerResources(state, { preserveFiredState: true });

    expect(state.cancelledEvents.has(id)).toBe(true);
  });

  it("clears timer handles during restart", async () => {
    const { context, event, facade } = restartFixture();
    await facade.forcePoll({ reason: "user" });

    facade.restart();
    facade.cancelPendingBrowserOpen(event.id);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(context.open).not.toHaveBeenCalled();
    facade.stop();
  });

  it("plain stop clears suppression maps", async () => {
    const { context, event, facade } = restartFixture();
    await facade.forcePoll({ reason: "user" });
    facade.cancelPendingBrowserOpen(event.id);
    facade.stop();

    await facade.forcePoll({ reason: "user" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(context.open).toHaveBeenCalledOnce();
    facade.stop();
  });
});
