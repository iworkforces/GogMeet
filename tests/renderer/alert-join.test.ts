import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AlertPayload } from "../../src/shared/alert.js";
import { asTestEventId, asTestIsoUtc } from "../helpers/test-utils.js";

/**
 * Integration-style tests for alert Join + Dismiss wiring against the real
 * alert renderer module (with stubbed window.api).
 */
describe("alert join and dismiss", () => {
  let onShowAlert: ((data: AlertPayload) => void) | null = null;
  const notifyDismissed = vi.fn();
  const joinMeeting = vi.fn().mockResolvedValue({ ok: true, value: undefined });

  beforeEach(async () => {
    vi.resetModules();
    onShowAlert = null;
    notifyDismissed.mockReset();
    joinMeeting.mockReset();
    joinMeeting.mockResolvedValue({ ok: true, value: undefined });
    // Isolate document listeners so re-imports do not stack click/keydown handlers.
    document.body.replaceWith(document.createElement("body"));
    document.body.innerHTML = '<div id="app"></div>';

    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        alert: {
          onShowAlert: (cb: (data: AlertPayload) => void) => {
            onShowAlert = cb;
            return () => {
              onShowAlert = null;
            };
          },
          notifyDismissed,
        },
        app: {
          joinMeeting,
        },
      },
    });

    await import("../../src/renderer/alert/index.js");
    document.dispatchEvent(new Event("DOMContentLoaded"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function showAlert(overrides: Partial<AlertPayload> = {}): void {
    const payload: AlertPayload = {
      id: asTestEventId("evt-alert-1"),
      title: "Standup",
      startDate: asTestIsoUtc(new Date().toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() + 30 * 60_000).toISOString()),
      calendarName: "Work",
      isAllDay: false,
      hasMeetUrl: true,
      ...overrides,
    };
    expect(onShowAlert).toBeTypeOf("function");
    onShowAlert!(payload);
  }

  it("renders Join when hasMeetUrl is true", () => {
    showAlert({ hasMeetUrl: true });
    expect(document.querySelector('[data-action="join"]')).not.toBeNull();
    expect(document.querySelector('[data-action="dismiss"]')).not.toBeNull();
  });

  it("omits Join when hasMeetUrl is false", () => {
    showAlert({ hasMeetUrl: false });
    expect(document.querySelector('[data-action="join"]')).toBeNull();
  });

  it("Join calls app.joinMeeting with event id and notifies dismiss", async () => {
    showAlert({ id: asTestEventId("evt-join-me"), hasMeetUrl: true });
    const joinBtn = document.querySelector<HTMLButtonElement>('[data-action="join"]');
    expect(joinBtn).not.toBeNull();
    joinBtn!.click();

    await vi.waitFor(() => {
      expect(joinMeeting).toHaveBeenCalledWith("evt-join-me");
    });
    await vi.waitFor(() => {
      expect(notifyDismissed).toHaveBeenCalledWith("evt-join-me");
    });
    const card = document.querySelector(".alert-card");
    expect(card).not.toBeNull();
    card?.dispatchEvent(new Event("animationend"));
  });

  it("Join failure keeps the alert open with an error banner", async () => {
    joinMeeting.mockResolvedValue({ ok: false, error: "Blocked by allowlist" });
    showAlert({ id: asTestEventId("evt-join-fail"), hasMeetUrl: true });
    const joinBtn = document.querySelector<HTMLButtonElement>('[data-action="join"]');
    expect(joinBtn).not.toBeNull();
    joinBtn!.click();

    await vi.waitFor(() => {
      expect(joinMeeting).toHaveBeenCalledWith("evt-join-fail");
    });
    await vi.waitFor(() => {
      const banner = document.getElementById("join-error");
      expect(banner).not.toBeNull();
      expect(banner?.textContent).toContain("Blocked by allowlist");
    });
    expect(notifyDismissed).not.toHaveBeenCalled();
    const btnAfter = document.querySelector<HTMLButtonElement>('[data-action="join"]');
    expect(btnAfter?.disabled).toBe(false);
    expect(btnAfter?.textContent).toContain("Join Meeting");
  });

  it("Join failure with empty error uses a generic message", async () => {
    joinMeeting.mockResolvedValue({ ok: false, error: "" });
    showAlert({ id: asTestEventId("evt-join-empty"), hasMeetUrl: true });
    document.querySelector<HTMLButtonElement>('[data-action="join"]')!.click();

    await vi.waitFor(() => {
      const banner = document.getElementById("join-error");
      expect(banner?.textContent).toContain("Could not open the meeting");
    });
    expect(notifyDismissed).not.toHaveBeenCalled();
  });

  it("Dismiss notifies main without joining", async () => {
    showAlert({ id: asTestEventId("evt-dismiss"), hasMeetUrl: true });
    document.querySelector<HTMLButtonElement>('[data-action="dismiss"]')!.click();

    await vi.waitFor(() => {
      expect(notifyDismissed).toHaveBeenCalledWith("evt-dismiss");
    });
    const card = document.querySelector(".alert-card");
    expect(card).not.toBeNull();
    card?.dispatchEvent(new Event("animationend"));
    expect(joinMeeting).not.toHaveBeenCalled();
  });
});
