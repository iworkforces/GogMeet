import { describe, it, expect } from "vitest";
import { planSchedule } from "../../src/main/scheduler/core/plan-schedule.js";
import type { ScheduleSnapshot } from "../../src/main/scheduler/core/schedule-types.js";
import { createMockEvent, asTestEventId, asTestMeetUrl } from "../helpers/test-utils.js";
import { DEFAULT_SETTINGS } from "../../src/domain/entities/settings.js";
import type { EventId } from "../../src/domain/entities/brand.js";

function emptySnapshot(overrides: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot {
  return {
    firedEvents: new Map(),
    alertFiredEvents: new Map(),
    pendingBrowserIds: new Set(),
    scheduledEventData: new Map(),
    inMeetingIds: new Set(),
    activeTitleEventId: null,
    previousActiveIds: new Set(),
    ...overrides,
  };
}

describe("planSchedule", () => {
  const now = Date.parse("2026-06-18T12:00:00.000Z");
  const settings = {
    ...DEFAULT_SETTINGS,
    openBeforeMinutes: 1,
    autoOpenEnabled: true,
    windowAlert: true,
    alertLeadSeconds: 60,
    nativeNotifications: true,
    quietHoursEnabled: false,
    lateJoinGraceMinutes: 0,
  };

  it("arms browser, alert, and title for a future meeting with URL", () => {
    const start = now + 10 * 60_000;
    const event = createMockEvent({
      id: asTestEventId("e1"),
      startDate: new Date(start).toISOString(),
      endDate: new Date(start + 30 * 60_000).toISOString(),
      meetUrl: asTestMeetUrl("https://meet.google.com/abc-def-ghi"),
    });

    const plan = planSchedule([event], settings, now, emptySnapshot(), {
      lateJoinGraceMs: 0,
    });

    const types = plan.actions.map((a) => a.type);
    expect(types).toContain("set-snapshot");
    expect(types).toContain("arm-browser");
    expect(types).toContain("arm-alert");
    expect(types).toContain("arm-title");
    expect(plan.activeIds.has(event.id)).toBe(true);
    // Snapshot must precede alert/title/browser so non-browser paths have state.
    const snapshotIdx = types.indexOf("set-snapshot");
    expect(snapshotIdx).toBeLessThan(types.indexOf("arm-alert"));
    expect(snapshotIdx).toBeLessThan(types.indexOf("arm-browser"));
    expect(snapshotIdx).toBeLessThan(types.indexOf("arm-title"));
  });

  it("with autoOpenEnabled=false: sets snapshot and arms alert/title, never browser", () => {
    const start = now + 10 * 60_000;
    const event = createMockEvent({
      id: asTestEventId("e1"),
      startDate: new Date(start).toISOString(),
      endDate: new Date(start + 30 * 60_000).toISOString(),
      meetUrl: asTestMeetUrl("https://meet.google.com/abc-def-ghi"),
    });
    const disabled = { ...settings, autoOpenEnabled: false };

    const plan = planSchedule([event], disabled, now, emptySnapshot(), {
      lateJoinGraceMs: 0,
    });

    const types = plan.actions.map((a) => a.type);
    expect(types).toContain("set-snapshot");
    expect(types).toContain("arm-alert");
    expect(types).toContain("arm-title");
    expect(types).not.toContain("arm-browser");

    const setSnap = plan.actions.find((a) => a.type === "set-snapshot");
    expect(setSnap).toMatchObject({
      type: "set-snapshot",
      eventId: event.id,
      snapshot: {
        title: event.title,
        meetUrl: event.meetUrl,
        startMs: start,
        endMs: start + 30 * 60_000,
        openAtMs: start - 60_000,
      },
    });
  });

  it("with autoOpenEnabled=false: identical second plan skips re-arm when snapshot present", () => {
    const start = now + 10 * 60_000;
    const openAtMs = start - 60_000;
    const event = createMockEvent({
      id: asTestEventId("e1"),
      startDate: new Date(start).toISOString(),
      endDate: new Date(start + 30 * 60_000).toISOString(),
      meetUrl: asTestMeetUrl("https://meet.google.com/abc-def-ghi"),
    });
    const disabled = { ...settings, autoOpenEnabled: false };

    const first = planSchedule([event], disabled, now, emptySnapshot(), {
      lateJoinGraceMs: 0,
    });
    expect(first.actions.some((a) => a.type === "set-snapshot")).toBe(true);

    const afterFirst = emptySnapshot({
      scheduledEventData: new Map([
        [
          event.id,
          {
            title: event.title,
            meetUrl: event.meetUrl,
            openAtMs,
            startMs: start,
            endMs: start + 30 * 60_000,
          },
        ],
      ]),
      previousActiveIds: new Set([event.id]),
    });
    const second = planSchedule([event], disabled, now, afterFirst, {
      lateJoinGraceMs: 0,
    });
    const secondTypes = second.actions.map((a) => a.type);
    expect(secondTypes).not.toContain("set-snapshot");
    expect(secondTypes).not.toContain("arm-alert");
    expect(secondTypes).not.toContain("arm-title");
    expect(secondTypes).not.toContain("arm-browser");
  });

  it("skips all-day events", () => {
    const event = createMockEvent({
      id: asTestEventId("e1"),
      isAllDay: true,
      meetUrl: asTestMeetUrl("https://meet.google.com/abc-def-ghi"),
    });
    const plan = planSchedule([event], settings, now, emptySnapshot(), {
      lateJoinGraceMs: 0,
    });
    expect(plan.actions.some((a) => a.type === "arm-browser")).toBe(false);
    expect(plan.activeIds.size).toBe(0);
  });

  it("emits clear-fired on start-time change after already fired", () => {
    const id = asTestEventId("e1");
    const start = now + 10 * 60_000;
    const event = createMockEvent({
      id,
      startDate: new Date(start).toISOString(),
      endDate: new Date(start + 30 * 60_000).toISOString(),
      meetUrl: asTestMeetUrl("https://meet.google.com/abc-def-ghi"),
    });
    const prevStart = start - 5 * 60_000;
    const snapshot = emptySnapshot({
      firedEvents: new Map([[id, now]]),
      scheduledEventData: new Map([
        [
          id,
          {
            title: event.title,
            meetUrl: event.meetUrl,
            openAtMs: prevStart - 60_000,
            startMs: prevStart,
            endMs: prevStart + 30 * 60_000,
          },
        ],
      ]),
    });

    const plan = planSchedule([event], settings, now, snapshot, { lateJoinGraceMs: 0 });
    expect(plan.actions.some((a) => a.type === "clear-fired" && a.eventId === id)).toBe(true);
    expect(plan.actions.some((a) => a.type === "arm-browser")).toBe(true);
  });

  it("emits update-title-only for title change when event owns tray title", () => {
    const id = asTestEventId("e1");
    const start = now + 10 * 60_000;
    const openAtMs = start - 60_000;
    const event = createMockEvent({
      id,
      title: "New title",
      startDate: new Date(start).toISOString(),
      endDate: new Date(start + 30 * 60_000).toISOString(),
      meetUrl: asTestMeetUrl("https://meet.google.com/abc-def-ghi"),
    });
    const snapshot = emptySnapshot({
      activeTitleEventId: id,
      scheduledEventData: new Map([
        [
          id,
          {
            title: "Old title",
            meetUrl: event.meetUrl,
            openAtMs,
            startMs: start,
            endMs: start + 30 * 60_000,
          },
        ],
      ]),
    });

    const plan = planSchedule([event], settings, now, snapshot, { lateJoinGraceMs: 0 });
    expect(plan.actions.some((a) => a.type === "update-title-only")).toBe(true);
    expect(plan.actions.some((a) => a.type === "arm-browser")).toBe(false);
  });

  it("resyncs in-meeting countdown when endMs changes while already in progress", () => {
    const start = now - 10 * 60_000;
    const oldEnd = now + 20 * 60_000;
    const newEnd = now + 5 * 60_000;
    const event = createMockEvent({
      id: asTestEventId("e1"),
      startDate: new Date(start).toISOString(),
      endDate: new Date(newEnd).toISOString(),
      meetUrl: asTestMeetUrl("https://meet.google.com/abc-def-ghi"),
    });
    const snapshot = emptySnapshot({
      inMeetingIds: new Set<EventId>([event.id]),
      scheduledEventData: new Map([
        [
          event.id,
          {
            title: event.title,
            meetUrl: event.meetUrl,
            openAtMs: start - 60_000,
            startMs: start,
            endMs: oldEnd,
          },
        ],
      ]),
      previousActiveIds: new Set<EventId>([event.id]),
    });

    const plan = planSchedule([event], settings, now, snapshot, { lateJoinGraceMs: 0 });
    const types = plan.actions.map((a) => a.type);
    expect(types).toContain("clear-in-meeting");
    expect(types).toContain("start-in-meeting");
    const startAction = plan.actions.find((a) => a.type === "start-in-meeting");
    expect(startAction).toMatchObject({ type: "start-in-meeting", endMs: newEnd });
  });

  it("arms enabled alert and notification during quiet hours", () => {
    const start = now + 10 * 60_000;
    const event = createMockEvent({
      id: asTestEventId("e1"),
      startDate: new Date(start).toISOString(),
      endDate: new Date(start + 30 * 60_000).toISOString(),
      meetUrl: asTestMeetUrl("https://meet.google.com/abc-def-ghi"),
    });
    const quietSettings = {
      ...settings,
      quietHoursEnabled: true,
      quietHoursStart: "00:00",
      quietHoursEnd: "23:59",
    };
    const plan = planSchedule([event], quietSettings, now, emptySnapshot(), {
      lateJoinGraceMs: 0,
    });
    expect(plan.actions.find((action) => action.type === "arm-alert")).toMatchObject({ event });
    expect(plan.actions.find((action) => action.type === "arm-browser")).toMatchObject({
      event,
      notify: true,
    });
  });

  it("does not arm disabled or previously fired alerts and keeps notifications disabled", () => {
    const start = now + 10 * 60_000;
    const event = createMockEvent({
      id: asTestEventId("e1"),
      startDate: new Date(start).toISOString(),
      endDate: new Date(start + 30 * 60_000).toISOString(),
      meetUrl: asTestMeetUrl("https://meet.google.com/abc-def-ghi"),
    });
    const disabled = { ...settings, windowAlert: false, nativeNotifications: false };
    const plan = planSchedule([event], disabled, now, emptySnapshot(), { lateJoinGraceMs: 0 });
    const fired = planSchedule(
      [event],
      settings,
      now,
      emptySnapshot({ alertFiredEvents: new Map([[event.id, now]]) }),
      { lateJoinGraceMs: 0 },
    );

    expect(plan.actions.some((action) => action.type === "arm-alert")).toBe(false);
    expect(plan.actions.find((action) => action.type === "arm-browser")).toMatchObject({
      notify: false,
    });
    expect(fired.actions.some((action) => action.type === "arm-alert")).toBe(false);
  });

  it("uses only the notification flag for late join during quiet hours", () => {
    const start = now - 60_000;
    const event = createMockEvent({
      id: asTestEventId("late"),
      startDate: new Date(start).toISOString(),
      endDate: new Date(start + 30 * 60_000).toISOString(),
      meetUrl: asTestMeetUrl("https://meet.google.com/abc-def-ghi"),
    });
    const quietSettings = {
      ...settings,
      quietHoursEnabled: true,
      quietHoursStart: "00:00",
      quietHoursEnd: "23:59",
    };
    const enabled = planSchedule([event], quietSettings, now, emptySnapshot(), {
      lateJoinGraceMs: 120_000,
    });
    const disabled = planSchedule(
      [event],
      { ...quietSettings, nativeNotifications: false },
      now,
      emptySnapshot(),
      { lateJoinGraceMs: 120_000 },
    );

    expect(enabled.actions.find((action) => action.type === "arm-browser")).toMatchObject({
      event,
      delayMs: 0,
      notify: true,
    });
    expect(disabled.actions.find((action) => action.type === "arm-browser")).toMatchObject({
      notify: false,
    });
  });
});
