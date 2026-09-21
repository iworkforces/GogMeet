import { describe, expect, it, vi } from "vitest";
import type { CalendarWatcherDependencies } from "../../src/main/facades/calendar-watcher.js";
import { createTestAppGraph } from "../../src/main/composition/create-test-app-graph.js";
import {
  okCalendarResult,
  createMockEvent,
  createMockSettings,
  asTestEventId,
} from "../helpers/test-utils.js";

vi.mock("../../src/main/facades/calendar-watcher.js", () => ({
  createCalendarWatcher: (dependencies: CalendarWatcherDependencies) => ({
    start: () => {
      void dependencies.forcePoll({ reason: "watch" });
    },
    stop: vi.fn(),
    revive: vi.fn(),
  }),
  startCalendarWatcher: vi.fn(),
  stopCalendarWatcher: vi.fn(),
  reviveCalendarWatcher: vi.fn(),
}));

describe("createTestAppGraph", () => {
  it("keeps real joins bound to their graph opener after another graph is constructed", async () => {
    const firstEvent = createMockEvent({ id: asTestEventId("first-event") });
    const secondEvent = createMockEvent({ id: asTestEventId("second-event") });
    const firstOpen = vi.fn().mockResolvedValue({ ok: true as const, value: undefined });
    const secondOpen = vi.fn().mockResolvedValue({ ok: true as const, value: undefined });
    const firstGetEvents = vi.fn().mockResolvedValue(okCalendarResult([firstEvent]));
    const secondGetEvents = vi.fn().mockResolvedValue(okCalendarResult([secondEvent]));
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();

    const first = createTestAppGraph({
      calendar: { getEventsResult: firstGetEvents },
      settings: { get: vi.fn(() => createMockSettings({ openBeforeMinutes: 2 })) },
      scheduler: {
        getLastKnownEvents: vi.fn(() => null),
        cancelPendingBrowserOpen: firstCancel,
      },
      opener: { open: firstOpen },
    });
    const second = createTestAppGraph({
      calendar: { getEventsResult: secondGetEvents },
      settings: { get: vi.fn(() => createMockSettings({ openBeforeMinutes: 7 })) },
      scheduler: {
        getLastKnownEvents: vi.fn(() => null),
        cancelPendingBrowserOpen: secondCancel,
      },
      opener: { open: secondOpen },
    });

    await first.join.byId(firstEvent.id);

    expect.soft(firstGetEvents).toHaveBeenCalledOnce();
    expect.soft(secondGetEvents).not.toHaveBeenCalled();
    expect.soft(firstOpen).toHaveBeenCalledOnce();
    expect.soft(secondOpen).not.toHaveBeenCalled();
    expect.soft(firstCancel).toHaveBeenCalledWith(firstEvent.id);
    expect.soft(secondCancel).not.toHaveBeenCalled();

    await second.join.byId(secondEvent.id);

    expect.soft(secondGetEvents).toHaveBeenCalledOnce();
    expect.soft(secondOpen).toHaveBeenCalledOnce();
    expect.soft(secondCancel).toHaveBeenCalledWith(secondEvent.id);
  });

  it("finalizes overrides before constructing join and watcher closures", async () => {
    const event = createMockEvent({ id: asTestEventId("override-event") });
    const getEventsResult = vi.fn().mockResolvedValue(okCalendarResult([event]));
    const finalOpen = vi.fn().mockResolvedValue({ ok: true as const, value: undefined });
    const cancelPendingBrowserOpen = vi.fn();
    const forcePoll = vi.fn().mockResolvedValue(null);
    const settings = createMockSettings({ openBeforeMinutes: 9 });

    const graph = createTestAppGraph({
      calendar: { getEventsResult },
      settings: { get: vi.fn(() => settings) },
      opener: { open: finalOpen },
      scheduler: {
        forcePoll,
        getLastKnownEvents: vi.fn(() => null),
        cancelPendingBrowserOpen,
      },
    });

    expect(graph.settings.get()).toBe(settings);
    await graph.join.byId(event.id);
    graph.watcher.start();

    expect.soft(getEventsResult).toHaveBeenCalledOnce();
    expect.soft(finalOpen).toHaveBeenCalledOnce();
    expect.soft(cancelPendingBrowserOpen).toHaveBeenCalledWith(event.id);
    expect(forcePoll).toHaveBeenCalledWith({ reason: "watch" });
  });
});
