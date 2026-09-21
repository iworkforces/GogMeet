import { describe, expect, it } from "vitest";
import { isLateJoinEligible } from "../../src/main/scheduler/late-join.js";
import {
  asTestEventId,
  asTestIsoUtc,
  asTestMeetUrl,
  createMockEvent,
} from "../helpers/test-utils.js";

const NOW = new Date("2026-06-18T12:00:00.000Z").getTime();
const START = NOW - 60_000;
const END = NOW + 30 * 60_000;

function event(overrides = {}) {
  return createMockEvent({
    id: asTestEventId("late"),
    meetUrl: asTestMeetUrl("https://meet.google.com/abc-def-ghi"),
    startDate: asTestIsoUtc(new Date(START).toISOString()),
    endDate: asTestIsoUtc(new Date(END).toISOString()),
    ...overrides,
  });
}

describe("isLateJoinEligible", () => {
  it.each([
    ["inside explicit grace", START, END, NOW, 120_000, false, true],
    ["at grace boundary", START, END, START + 120_000, 120_000, false, false],
    ["grace disabled", START, END, NOW, 0, false, false],
    ["before meeting start", START, END, START - 1, 120_000, false, false],
    ["after meeting end", START, END, END, 60 * 60_000, false, false],
    ["already fired", START, END, NOW, 120_000, true, false],
  ])("returns the expected result when %s", (_name, start, end, now, grace, fired, expected) => {
    const meeting = event();
    const firedEvents = fired ? new Map([[meeting.id, end]]) : new Map();
    expect(isLateJoinEligible(meeting, start, end, now, grace, { firedEvents })).toBe(expected);
  });

  it("does not depend on title-countdown cancellation state", () => {
    const meeting = event();
    expect(
      isLateJoinEligible(meeting, START, END, NOW, 120_000, {
        firedEvents: new Map(),
      }),
    ).toBe(true);
  });

  it("evaluates different explicit grace values independently", () => {
    const meeting = event();
    const state = { firedEvents: new Map() };
    expect(isLateJoinEligible(meeting, START, END, NOW, 30_000, state)).toBe(false);
    expect(isLateJoinEligible(meeting, START, END, NOW, 120_000, state)).toBe(true);
  });
});
