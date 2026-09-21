import { describe, expect, it, vi } from "vitest";
import { createJoinMeeting } from "../../src/main/application/use-cases/join-meeting.js";
import type { JoinMeetingDeps } from "../../src/main/application/use-cases/join-meeting.js";
import { err, ok } from "../../src/domain/entities/result.js";
import {
  asTestEventId,
  asTestMeetUrl,
  createMockEvent,
  okCalendarResult,
} from "../helpers/test-utils.js";

const event = createMockEvent({
  id: asTestEventId("evt-1"),
  meetUrl: asTestMeetUrl("https://meet.google.com/abc-def-ghi"),
});

function createJoinHarness() {
  const getLastKnownEvents = vi.fn<JoinMeetingDeps["getLastKnownEvents"]>(() =>
    okCalendarResult([event]),
  );
  const fetchCalendarEvents = vi.fn<JoinMeetingDeps["fetchCalendarEvents"]>(async () =>
    okCalendarResult([event]),
  );
  const open = vi.fn<JoinMeetingDeps["opener"]["open"]>(async () => ok(undefined));
  const cancelPendingBrowserOpen = vi.fn<JoinMeetingDeps["cancelPendingBrowserOpen"]>();
  const joinMeeting = createJoinMeeting({
    getLastKnownEvents,
    fetchCalendarEvents,
    opener: { open },
    cancelPendingBrowserOpen,
  });

  return {
    joinMeeting,
    getLastKnownEvents,
    fetchCalendarEvents,
    open,
    cancelPendingBrowserOpen,
  };
}

describe("createJoinMeeting", () => {
  it("opens from cache and cancels the pending auto-open", async () => {
    const harness = createJoinHarness();

    const result = await harness.joinMeeting.execute(event.id);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(harness.fetchCalendarEvents).not.toHaveBeenCalled();
    expect(harness.open).toHaveBeenCalledWith(
      "https://meet.google.com/abc-def-ghi?authuser=user%40example.com",
    );
    expect(harness.cancelPendingBrowserOpen).toHaveBeenCalledWith(event.id);
  });

  it("fetches when the event is missing from the cached result", async () => {
    const harness = createJoinHarness();
    harness.getLastKnownEvents.mockReturnValue(okCalendarResult());

    const result = await harness.joinMeeting.execute(event.id);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(harness.fetchCalendarEvents).toHaveBeenCalledOnce();
    expect(harness.open).toHaveBeenCalledWith(
      "https://meet.google.com/abc-def-ghi?authuser=user%40example.com",
    );
    expect(harness.cancelPendingBrowserOpen).toHaveBeenCalledWith(event.id);
  });

  it("does not cancel the pending auto-open when opening fails", async () => {
    const harness = createJoinHarness();
    harness.open.mockResolvedValue(err("blocked"));

    const result = await harness.joinMeeting.execute(event.id);

    expect(result).toEqual({ ok: false, error: "blocked" });
    expect(harness.cancelPendingBrowserOpen).not.toHaveBeenCalled();
  });

  it("returns the calendar error when the fallback fetch fails", async () => {
    const harness = createJoinHarness();
    harness.getLastKnownEvents.mockReturnValue(null);
    harness.fetchCalendarEvents.mockResolvedValue({
      kind: "err",
      error: "denied",
      code: "permission-denied",
    });

    const result = await harness.joinMeeting.execute(event.id);

    expect(result).toEqual({ ok: false, error: "denied" });
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.cancelPendingBrowserOpen).not.toHaveBeenCalled();
  });
});
