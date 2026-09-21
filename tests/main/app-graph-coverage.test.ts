import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JoinMeetingDeps } from "../../src/main/application/use-cases/join-meeting.js";
import type { CalendarWatcherDependencies } from "../../src/main/facades/calendar-watcher.js";
import type { SchedulerDependencies } from "../../src/main/scheduler/facade.js";

const {
  constructionOrder,
  calendarFacade,
  settingsFacade,
  schedulerFacade,
  watcher,
  createCalendarFacade,
  createSettingsFacade,
  createSchedulerFacade,
  createJoinMeeting,
  createCalendarWatcher,
  createShellMeetingOpener,
  joinMeetingById,
  openMock,
} = vi.hoisted(() => {
  const constructionOrder: string[] = [];
  const publication = {
    publicationGeneration: 1,
    result: {
      kind: "ok" as const,
      source: "live" as const,
      completeness: "complete" as const,
      observedAt: Date.now(),
      events: [],
    },
  };
  const calendarFacade = {
    refreshCalendarPublication: vi.fn().mockResolvedValue(publication),
    getCalendarEventsResult: vi.fn().mockResolvedValue(publication.result),
    getLastPublication: vi.fn().mockReturnValue(publication),
    cancelActiveCalendarRefresh: vi.fn(),
    requestCalendarPermission: vi.fn().mockResolvedValue("granted"),
    getCalendarPermissionStatus: vi.fn().mockResolvedValue("granted"),
    invalidateCalendarPermissionCache: vi.fn(),
    shouldAutoRequestCalendarPermission: vi.fn().mockReturnValue(false),
    warmupCalendarProvider: vi.fn().mockResolvedValue(undefined),
    disconnectCalendar: vi.fn().mockResolvedValue(undefined),
    reportCalendarPollError: vi.fn(),
    getCalendarUiState: vi.fn().mockReturnValue({ phase: "ready" }),
    getCalendarPort: vi.fn().mockResolvedValue({}),
  };
  const settingsFacade = {
    load: vi.fn(),
    save: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
  };
  const schedulerFacade = {
    forcePoll: vi.fn().mockResolvedValue(publication),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    setWindow: vi.fn(),
    setTrayTitleCallback: vi.fn(),
    initPowerCallbacks: vi.fn(),
    getLastKnownEvents: vi.fn().mockReturnValue(null),
    republishUiForDisplayTick: vi.fn(),
    cancelPendingBrowserOpen: vi.fn(),
  };
  const watcher = {
    start: vi.fn(),
    stop: vi.fn(),
    revive: vi.fn(),
  };
  const joinMeetingById = vi.fn().mockResolvedValue({ ok: true as const, value: undefined });
  const openMock = vi.fn().mockResolvedValue({ ok: true as const, value: undefined });

  return {
    constructionOrder,
    calendarFacade,
    settingsFacade,
    schedulerFacade,
    watcher,
    createCalendarFacade: vi.fn(() => {
      constructionOrder.push("calendar");
      return calendarFacade;
    }),
    createSettingsFacade: vi.fn(() => {
      constructionOrder.push("settings");
      return settingsFacade;
    }),
    createSchedulerFacade: vi.fn((_dependencies: SchedulerDependencies) => {
      constructionOrder.push("scheduler");
      return schedulerFacade;
    }),
    createJoinMeeting: vi.fn((_dependencies: JoinMeetingDeps) => {
      constructionOrder.push("join");
      return { execute: joinMeetingById };
    }),
    createCalendarWatcher: vi.fn((_dependencies: CalendarWatcherDependencies) => {
      constructionOrder.push("watcher");
      return watcher;
    }),
    createShellMeetingOpener: vi.fn(() => {
      constructionOrder.push("opener");
      return { open: openMock };
    }),
    joinMeetingById,
    openMock,
  };
});

vi.mock("../../src/main/facades/calendar.js", () => ({ createCalendarFacade }));
vi.mock("../../src/main/facades/settings.js", () => ({ createSettingsFacade }));
vi.mock("../../src/main/scheduler/facade.js", () => ({ createSchedulerFacade }));
vi.mock("../../src/main/application/use-cases/join-meeting.js", () => ({ createJoinMeeting }));
vi.mock("../../src/main/facades/calendar-watcher.js", () => ({ createCalendarWatcher }));
vi.mock("../../src/main/infrastructure/electron/shell-meeting-opener.js", () => ({
  createShellMeetingOpener,
}));

import { createAppGraph } from "../../src/main/composition/app-graph.js";
import { asTestEventId, createMockSettings } from "../helpers/test-utils.js";

describe("createAppGraph surface coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constructionOrder.length = 0;
  });

  it("constructs factories in dependency order and invokes every graph surface", async () => {
    const settings = createMockSettings({ openBeforeMinutes: 1 });
    const updatedSettings = createMockSettings({ openBeforeMinutes: 2 });
    settingsFacade.load.mockResolvedValue({ ok: true, value: settings });
    settingsFacade.get.mockReturnValue(settings);
    settingsFacade.update.mockResolvedValue(updatedSettings);
    settingsFacade.save.mockResolvedValue(undefined);

    const graph = createAppGraph();

    expect(constructionOrder).toEqual([
      "opener",
      "calendar",
      "settings",
      "scheduler",
      "join",
      "watcher",
    ]);
    expect(createCalendarFacade).toHaveBeenCalledOnce();
    expect(createSettingsFacade).toHaveBeenCalledOnce();
    expect(createSchedulerFacade).toHaveBeenCalledOnce();
    expect(createJoinMeeting).toHaveBeenCalledOnce();
    expect(createCalendarWatcher).toHaveBeenCalledOnce();

    expect(await graph.calendar.getEvents()).toMatchObject({ publicationGeneration: 1 });
    expect((await graph.calendar.getEventsResult()).kind).toBe("ok");
    expect(await graph.calendar.requestPermission()).toBe("granted");
    expect(await graph.calendar.getPermissionStatus()).toBe("granted");
    await graph.calendar.disconnect();
    expect(graph.calendar.getUiState().phase).toBe("ready");
    await graph.calendar.warmup();
    graph.calendar.invalidatePermissionCache();
    expect(graph.calendar.shouldAutoRequestPermission()).toBe(false);
    graph.calendar.reportPollError("e", null);
    expect(calendarFacade.reportCalendarPollError).toHaveBeenCalledWith("e", null);

    expect(await graph.settings.load()).toEqual({ ok: true, value: settings });
    expect(graph.settings.get()).toBe(settings);
    expect(await graph.settings.update({ openBeforeMinutes: 2 })).toBe(updatedSettings);
    await graph.settings.save(updatedSettings);

    const id = asTestEventId("e1");
    expect(await graph.join.byId(id)).toEqual({ ok: true, value: undefined });
    expect(joinMeetingById).toHaveBeenCalledWith(id);
    expect(await graph.opener.open("https://meet.google.com/abc-defg-hij")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(openMock).toHaveBeenCalledOnce();

    await graph.scheduler.forcePoll();
    expect(graph.scheduler.getLastKnownEvents()).toBeNull();
    graph.scheduler.republishUiForDisplayTick();
    graph.scheduler.cancelPendingBrowserOpen(id);
    graph.scheduler.start();
    graph.scheduler.stop();
    graph.scheduler.restart();
    graph.scheduler.setWindow({} as never);
    const updateTrayTitle = (): void => {};
    graph.scheduler.setTrayTitleCallback(updateTrayTitle);
    const power = {
      getPollInterval: () => 120_000,
      preventSleep: () => {},
      allowSleep: () => {},
    };
    graph.scheduler.initPowerCallbacks(power);
    expect(schedulerFacade.republishUiForDisplayTick).toHaveBeenCalledOnce();

    graph.watcher.start();
    graph.watcher.stop();
    graph.watcher.revive();
    expect(watcher.start).toHaveBeenCalledOnce();
    expect(watcher.stop).toHaveBeenCalledOnce();
    expect(watcher.revive).toHaveBeenCalledOnce();
  });

  it("passes finalized surfaces into downstream factories", () => {
    const getEvents = vi.fn();
    const getEventsResult = vi.fn();
    const reportPollError = vi.fn();
    const getSettings = vi.fn();
    const forcePoll = vi.fn();
    const getLastKnownEvents = vi.fn();
    const cancelPendingBrowserOpen = vi.fn();
    const open = vi.fn();
    const opener = { open };

    const graph = createAppGraph({
      calendar: { getEvents, getEventsResult, reportPollError },
      settings: { get: getSettings },
      scheduler: { forcePoll, getLastKnownEvents, cancelPendingBrowserOpen },
      opener,
    });

    expect(createSchedulerFacade).toHaveBeenCalledWith({
      calendar: {
        refreshCalendarPublication: getEvents,
        getLastPublication: calendarFacade.getLastPublication,
        cancelActiveCalendarRefresh: calendarFacade.cancelActiveCalendarRefresh,
        reportCalendarPollError: reportPollError,
      },
      settings: { get: getSettings },
      opener,
    });
    expect(createJoinMeeting).toHaveBeenCalledWith({
      getLastKnownEvents,
      fetchCalendarEvents: getEventsResult,
      opener,
      cancelPendingBrowserOpen,
    });
    expect(createCalendarWatcher).toHaveBeenCalledWith({
      getCalendarPort: calendarFacade.getCalendarPort,
      forcePoll,
    });
    expect(graph.opener).toBe(opener);
  });
});
