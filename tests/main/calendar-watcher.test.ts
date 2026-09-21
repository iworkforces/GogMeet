import { describe, expect, it, vi } from "vitest";
import { createCalendarWatcher } from "../../src/main/facades/calendar-watcher.js";
import type { CalendarWatcherDependencies } from "../../src/main/facades/calendar-watcher.js";
import type { CalendarPort } from "../../src/main/application/ports/calendar-port.js";

function createDependencies(getCalendarPort: CalendarWatcherDependencies["getCalendarPort"]): {
  readonly dependencies: CalendarWatcherDependencies;
  readonly forcePoll: ReturnType<typeof vi.fn<CalendarWatcherDependencies["forcePoll"]>>;
} {
  const forcePoll = vi.fn<CalendarWatcherDependencies["forcePoll"]>(() => Promise.resolve(null));
  return { dependencies: { getCalendarPort, forcePoll }, forcePoll };
}

describe("createCalendarWatcher", () => {
  it("keeps two watcher lifecycles and callbacks isolated", async () => {
    const firstPort = Promise.withResolvers<CalendarPort>();
    const secondPort = Promise.withResolvers<CalendarPort>();
    let firstCallback: (() => void) | undefined;
    let secondCallback: (() => void) | undefined;
    const firstStartWatch = vi.fn((callback: () => void) => {
      firstCallback = callback;
    });
    const secondStartWatch = vi.fn((callback: () => void) => {
      secondCallback = callback;
    });
    const firstStopWatch = vi.fn();
    const secondReviveWatch = vi.fn();
    const first = createDependencies(() => firstPort.promise);
    const second = createDependencies(() => secondPort.promise);
    const firstWatcher = createCalendarWatcher(first.dependencies);
    const secondWatcher = createCalendarWatcher(second.dependencies);

    firstWatcher.start();
    secondWatcher.start();
    secondPort.resolve(
      { startWatch: secondStartWatch, reviveWatch: secondReviveWatch }.As<CalendarPort>(),
    );
    await vi.waitFor(() => expect(secondStartWatch).toHaveBeenCalledOnce());
    secondWatcher.revive();
    firstPort.resolve(
      { startWatch: firstStartWatch, stopWatch: firstStopWatch }.As<CalendarPort>(),
    );
    await vi.waitFor(() => expect(firstStartWatch).toHaveBeenCalledOnce());
    firstCallback?.();
    secondCallback?.();
    firstWatcher.stop();
    firstCallback?.();

    expect(first.forcePoll).toHaveBeenCalledOnce();
    expect(second.forcePoll).toHaveBeenCalledOnce();
    expect(firstStopWatch).toHaveBeenCalledOnce();
    expect(secondReviveWatch).toHaveBeenCalledOnce();
  });

  it("is idempotent and logs poll-only providers", async () => {
    const getCalendarPort = vi.fn<CalendarWatcherDependencies["getCalendarPort"]>(() =>
      Promise.resolve({}.As<CalendarPort>()),
    );
    const { dependencies } = createDependencies(getCalendarPort);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const watcher = createCalendarWatcher(dependencies);

    watcher.start();
    watcher.start();
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith("[calendar-watcher] No watch (poll-only)"),
    );
    watcher.stop();
    watcher.stop();

    expect(getCalendarPort).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("warns when port resolution fails", async () => {
    const { dependencies } = createDependencies(() => Promise.reject(new Error("no provider")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const watcher = createCalendarWatcher(dependencies);

    watcher.start();

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "[calendar-watcher] Failed to start watch:",
        expect.any(Error),
      ),
    );
    watcher.stop();
    warn.mockRestore();
  });

  it("warns and clears lifecycle state when stopWatch fails", async () => {
    const startWatch = vi.fn();
    const stopWatch = vi.fn(() => {
      throw new Error("boom");
    });
    const { dependencies } = createDependencies(() =>
      Promise.resolve({ startWatch, stopWatch }.As<CalendarPort>()),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const watcher = createCalendarWatcher(dependencies);

    watcher.start();
    await vi.waitFor(() => expect(startWatch).toHaveBeenCalledOnce());
    watcher.stop();
    watcher.stop();

    expect(stopWatch).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("[calendar-watcher] stopWatch failed:", expect.any(Error));
    warn.mockRestore();
  });

  it("does not start a port that resolves after stop", async () => {
    const deferred = Promise.withResolvers<CalendarPort>();
    const startWatch = vi.fn();
    const { dependencies } = createDependencies(() => deferred.promise);
    const watcher = createCalendarWatcher(dependencies);

    watcher.start();
    watcher.stop();
    deferred.resolve({ startWatch }.As<CalendarPort>());
    await Promise.resolve();

    expect(startWatch).not.toHaveBeenCalled();
  });

  it("does not let a stale resolution overwrite a restarted lifecycle", async () => {
    const firstPort = Promise.withResolvers<CalendarPort>();
    const secondPort = Promise.withResolvers<CalendarPort>();
    const firstStartWatch = vi.fn();
    const secondStartWatch = vi.fn();
    const getCalendarPort = vi
      .fn<CalendarWatcherDependencies["getCalendarPort"]>()
      .mockReturnValueOnce(firstPort.promise)
      .mockReturnValueOnce(secondPort.promise);
    const { dependencies } = createDependencies(getCalendarPort);
    const watcher = createCalendarWatcher(dependencies);

    watcher.start();
    watcher.stop();
    watcher.start();
    firstPort.resolve({ startWatch: firstStartWatch }.As<CalendarPort>());
    secondPort.resolve({ startWatch: secondStartWatch }.As<CalendarPort>());
    await vi.waitFor(() => expect(secondStartWatch).toHaveBeenCalledOnce());

    expect(firstStartWatch).not.toHaveBeenCalled();
  });

  it("does not poll from a stale provider callback", async () => {
    let callback: (() => void) | undefined;
    const startWatch = vi.fn((onChange: () => void) => {
      callback = onChange;
    });
    const { dependencies, forcePoll } = createDependencies(() =>
      Promise.resolve({ startWatch }.As<CalendarPort>()),
    );
    const watcher = createCalendarWatcher(dependencies);

    watcher.start();
    await vi.waitFor(() => expect(startWatch).toHaveBeenCalledOnce());
    watcher.stop();
    callback?.();

    expect(forcePoll).not.toHaveBeenCalled();
  });

  it("warns instead of throwing when a cached reviveWatch fails", async () => {
    const startWatch = vi.fn();
    const reviveWatch = vi.fn(() => {
      throw new Error("boom");
    });
    const { dependencies } = createDependencies(() =>
      Promise.resolve({ startWatch, reviveWatch }.As<CalendarPort>()),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const watcher = createCalendarWatcher(dependencies);

    watcher.start();
    await vi.waitFor(() => expect(startWatch).toHaveBeenCalledOnce());

    expect(() => watcher.revive()).not.toThrow();
    expect(warn).toHaveBeenCalledWith("[calendar-watcher] revive failed:", expect.any(Error));
    warn.mockRestore();
  });

  it("warns without an unhandled rejection when watch polling fails", async () => {
    let callback: (() => void) | undefined;
    const startWatch = vi.fn((onChange: () => void) => {
      callback = onChange;
    });
    const { dependencies, forcePoll } = createDependencies(() =>
      Promise.resolve({ startWatch }.As<CalendarPort>()),
    );
    forcePoll.mockRejectedValueOnce(new Error("poll failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    const watcher = createCalendarWatcher(dependencies);

    try {
      watcher.start();
      await vi.waitFor(() => expect(startWatch).toHaveBeenCalledOnce());
      callback?.();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(forcePoll).toHaveBeenCalledWith({ reason: "watch" });
      expect(warn).toHaveBeenCalledWith("[calendar-watcher] watch poll failed:", expect.any(Error));
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
      warn.mockRestore();
    }
  });

  it("does not revive a port resolved after its lifecycle stops", async () => {
    const deferred = Promise.withResolvers<CalendarPort>();
    const reviveWatch = vi.fn();
    const { dependencies } = createDependencies(() => deferred.promise);
    const watcher = createCalendarWatcher(dependencies);

    watcher.start();
    watcher.revive();
    watcher.stop();
    deferred.resolve({ reviveWatch }.As<CalendarPort>());
    await Promise.resolve();

    expect(reviveWatch).not.toHaveBeenCalled();
  });

  it("revives the cached port, pending resolution, and never a stopped watcher", async () => {
    const deferred = Promise.withResolvers<CalendarPort>();
    const reviveWatch = vi.fn();
    const getCalendarPort = vi.fn<CalendarWatcherDependencies["getCalendarPort"]>(
      () => deferred.promise,
    );
    const { dependencies } = createDependencies(getCalendarPort);
    const watcher = createCalendarWatcher(dependencies);

    watcher.revive();
    watcher.start();
    watcher.revive();
    deferred.resolve({ reviveWatch }.As<CalendarPort>());
    await vi.waitFor(() => expect(reviveWatch).toHaveBeenCalledOnce());
    watcher.revive();
    watcher.stop();
    watcher.revive();

    expect(reviveWatch).toHaveBeenCalledTimes(2);
    expect(getCalendarPort).toHaveBeenCalledOnce();
  });
});
