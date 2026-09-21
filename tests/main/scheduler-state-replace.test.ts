import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { createSchedulerFacade } from "../../src/main/scheduler/facade.js";
import {
  clearSchedulerResources,
  createSchedulerState,
} from "../../src/main/scheduler/state/index.js";
import { schedulerTestContext } from "../helpers/scheduler-runtime.js";
import { asTestEventId, okCalendarResult } from "../helpers/test-utils.js";

describe("scheduler state replacement contracts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("preserves window, title, and power callback identity across restart", () => {
    const context = schedulerTestContext();
    const facade = createSchedulerFacade(context.dependencies);
    const window = { id: 42 }.As<BrowserWindow>();
    const title = vi.fn();
    const power = {
      getPollInterval: () => 60_000,
      preventSleep: vi.fn(),
      allowSleep: vi.fn(),
    };
    facade.setWindow(window);
    facade.setTrayTitleCallback(title);
    facade.initPowerCallbacks(power);

    facade.restart();
    facade.stop();

    expect(title).toHaveBeenCalledWith(null);
    expect(context.cancelRefresh).toHaveBeenCalledTimes(2);
  });

  it("preserves lastKnownEvents across stop and restart", async () => {
    const result = okCalendarResult();
    const context = schedulerTestContext(undefined, {
      publicationGeneration: 7,
      result,
    });
    const facade = createSchedulerFacade(context.dependencies);
    await facade.forcePoll({ reason: "user" });

    facade.stop();
    expect(facade.getLastKnownEvents()).toBe(result);
    facade.restart();
    await vi.runAllTicks();
    expect(facade.getLastKnownEvents()).toBe(result);
    facade.stop();
  });

  it("clears old poll handles while retaining cached events", () => {
    const state = createSchedulerState();
    const handle = setTimeout(() => {}, 60_000);
    const events = okCalendarResult();
    state.pollTimeout = handle;
    state.lastKnownEvents = events;

    clearSchedulerResources(state, { preserveLastKnownEvents: true });

    expect(state.pollTimeout).toBeNull();
    expect(state.lastKnownEvents).toBe(events);
  });

  it("clears countdown intervals without power callbacks", () => {
    const state = createSchedulerState();
    state.powerCallbacks = null;
    state.countdownIntervals.set(
      asTestEventId("countdown"),
      setInterval(() => {}, 60_000),
    );

    expect(() => clearSchedulerResources(state)).not.toThrow();
    expect(state.countdownIntervals.size).toBe(0);
  });

  it("releases one sleep blocker per countdown interval on bulk reset", () => {
    const state = createSchedulerState();
    const allowSleep = vi.fn();
    state.powerCallbacks = {
      getPollInterval: () => 120_000,
      preventSleep: vi.fn(),
      allowSleep,
    };
    state.countdownIntervals.set(
      asTestEventId("a"),
      setInterval(() => {}, 60_000),
    );
    state.countdownIntervals.set(
      asTestEventId("b"),
      setInterval(() => {}, 60_000),
    );

    clearSchedulerResources(state);

    expect(allowSleep).toHaveBeenCalledTimes(2);
    expect(state.countdownIntervals.size).toBe(0);
  });

  it("does not release sleep for clear timers", () => {
    const state = createSchedulerState();
    const allowSleep = vi.fn();
    state.powerCallbacks = {
      getPollInterval: () => 120_000,
      preventSleep: vi.fn(),
      allowSleep,
    };
    state.clearTimers.set(
      asTestEventId("clear"),
      setTimeout(() => {}, 60_000),
    );

    clearSchedulerResources(state);

    expect(allowSleep).not.toHaveBeenCalled();
    expect(state.clearTimers.size).toBe(0);
  });

  it("preserves fired suppression while clearing countdown resources", () => {
    const state = createSchedulerState();
    const id = asTestEventId("fired");
    const allowSleep = vi.fn();
    state.powerCallbacks = {
      getPollInterval: () => 120_000,
      preventSleep: vi.fn(),
      allowSleep,
    };
    state.countdownIntervals.set(
      id,
      setInterval(() => {}, 60_000),
    );
    state.firedEvents.set(id, 123);

    clearSchedulerResources(state, { preserveFiredState: true });

    expect(allowSleep).toHaveBeenCalledOnce();
    expect(state.firedEvents.get(id)).toBe(123);
  });
});
