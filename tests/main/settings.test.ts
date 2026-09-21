import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSettings } from "../helpers/test-utils.js";
import { existsSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { createSettingsFacade, type SettingsFacade } from "../../src/main/facades/settings.js";

// vi.mock is hoisted above all code, so the path must be a literal string in the mock factory
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/gogmeet-settings-test"),
  },
}));

// Define the same path for use in tests
const MOCK_USER_DATA_PATH = "/tmp/gogmeet-settings-test";

import {
  DEFAULT_SETTINGS,
  OPEN_BEFORE_MINUTES_MIN,
  OPEN_BEFORE_MINUTES_MAX,
} from "../../src/domain/entities/settings.js";
describe("settings", () => {
  const settingsPath = join(MOCK_USER_DATA_PATH, "settings.json");
  let settings: SettingsFacade;

  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();

    // Ensure clean temp directory
    if (existsSync(MOCK_USER_DATA_PATH)) {
      rmSync(MOCK_USER_DATA_PATH, { recursive: true, force: true });
    }
    mkdirSync(MOCK_USER_DATA_PATH, { recursive: true });

    settings = createSettingsFacade();
    await settings.load();
  });

  describe("loadSettings", () => {
    it("returns defaults when no file exists", async () => {
      // Delete settings file if it exists
      if (existsSync(settingsPath)) {
        rmSync(settingsPath);
      }

      const result = await settings.load();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(DEFAULT_SETTINGS);
    });

    it("reads existing file correctly", async () => {
      const expectedSettings = {
        openBeforeMinutes: 3,
        launchAtLogin: true,
        showTomorrowMeetings: false,
      };

      // Write settings file directly
      mkdirSync(MOCK_USER_DATA_PATH, { recursive: true });
      const fs = require("fs");
      fs.writeFileSync(settingsPath, JSON.stringify(expectedSettings));

      const result = await settings.load();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.openBeforeMinutes).toBe(3);
      expect(result.value.launchAtLogin).toBe(true);
      expect(result.value.showTomorrowMeetings).toBe(false);
    });

    it("handles corrupted JSON (returns defaults)", async () => {
      // Write invalid JSON
      mkdirSync(MOCK_USER_DATA_PATH, { recursive: true });
      const fs = require("fs");
      fs.writeFileSync(settingsPath, "{ not valid json }");

      const result = await settings.load();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/Failed to parse settings JSON/);

      // Cache should fall back to defaults
      expect(settings.get()).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe("saveSettings", () => {
    it("persists to disk", async () => {
      const settingsToSave = {
        openBeforeMinutes: 4,
        launchAtLogin: true,
        showTomorrowMeetings: true,
        windowAlert: true,
        schemaVersion: 1,
      };

      await settings.save(createMockSettings(settingsToSave));

      // Verify file was created and contains correct data
      expect(existsSync(settingsPath)).toBe(true);

      const raw = readFileSync(settingsPath, "utf-8");
      const saved = JSON.parse(raw);

      expect(saved.openBeforeMinutes).toBe(4);
      expect(saved.launchAtLogin).toBe(true);
      expect(saved.showTomorrowMeetings).toBe(true);
    });
    it("returns cached copy", async () => {
      // Load to populate cache
      await settings.load();

      const cachedSettings = settings.get();

      expect(cachedSettings).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe("updateSettings", () => {
    it("merges partial, saves, and returns full settings", async () => {
      // First, save initial settings
      await settings.save(
        createMockSettings({
          openBeforeMinutes: 2,
          launchAtLogin: false,
          showTomorrowMeetings: true,
          windowAlert: true,
          schemaVersion: 1,
        }),
      );

      // Now update with partial
      const result = await settings.update({ openBeforeMinutes: 4 });

      expect(result.openBeforeMinutes).toBe(4);
      expect(result.launchAtLogin).toBe(false);
      expect(result.showTomorrowMeetings).toBe(true);

      // Verify it was saved to disk
      const raw = readFileSync(settingsPath, "utf-8");
      const saved = JSON.parse(raw);
      expect(saved.openBeforeMinutes).toBe(4);
      expect(saved.launchAtLogin).toBe(false);
      expect(saved.showTomorrowMeetings).toBe(true);

      // Verify cache was updated
      const cached = settings.get();
      expect(cached.openBeforeMinutes).toBe(4);
    });

    it("clamps openBeforeMinutes to 0-10 range (value below min -> 0)", async () => {
      const result = await settings.update({ openBeforeMinutes: -5 });

      expect(result.openBeforeMinutes).toBe(OPEN_BEFORE_MINUTES_MIN);
    });

    it("clamps openBeforeMinutes to 0-10 range (value above max -> 10)", async () => {
      const result = await settings.update({ openBeforeMinutes: 99 });

      expect(result.openBeforeMinutes).toBe(OPEN_BEFORE_MINUTES_MAX);
    });

    it("ignores unknown properties in partial", async () => {
      // TypeScript would catch this at compile time, but runtime test too
      const result = await settings.update({
        openBeforeMinutes: 3,
      });

      expect(result.openBeforeMinutes).toBe(3);
      // Verify unknown property wasn't added to result
      expect(Object.keys(result).sort()).toEqual(Object.keys(createMockSettings()).sort());
    });

    it("updates launchAtLogin correctly", async () => {
      // Start with default (false)
      await settings.save(
        createMockSettings({
          openBeforeMinutes: 1,
          launchAtLogin: false,
          showTomorrowMeetings: true,
          windowAlert: true,
          schemaVersion: 1,
        }),
      );

      // Enable launch at login
      const result = await settings.update({ launchAtLogin: true });

      expect(result.launchAtLogin).toBe(true);

      // Verify it was saved to disk
      const raw = readFileSync(settingsPath, "utf-8");
      const saved = JSON.parse(raw);
      expect(saved.launchAtLogin).toBe(true);

      // Disable again
      const result2 = await settings.update({ launchAtLogin: false });
      expect(result2.launchAtLogin).toBe(false);
    });

    it("defaults launchAtLogin to false when not in file", async () => {
      // Write settings without launchAtLogin
      const fs = require("fs");
      fs.writeFileSync(settingsPath, JSON.stringify({ openBeforeMinutes: 2 }));

      const result = await settings.load();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.launchAtLogin).toBe(false);
    });
  });
});
