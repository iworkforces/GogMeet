import { describe, expect, it, vi } from "vitest";
import { createMockSettings } from "../helpers/test-utils.js";
import { createSettingsFacade } from "../../src/main/facades/settings.js";
import type { AppSettings } from "../../src/domain/entities/settings.js";
import type { JsonSettingsStore } from "../../src/main/infrastructure/settings/json-settings-store.js";

function createStore(initial: AppSettings): JsonSettingsStore {
  let current = initial;

  return {
    load: vi.fn(async () => ({ ok: true as const, value: { ...current } })),
    get: vi.fn(() => ({ ...current })),
    update: vi.fn(async (partial: Partial<AppSettings>) => {
      current = { ...current, ...partial };
      return { ...current };
    }),
    save: vi.fn(async (settings: AppSettings) => {
      current = { ...settings };
    }),
  };
}

describe("settings facade", () => {
  it("keeps interleaved facades backed by their own stores", async () => {
    const firstStore = createStore(createMockSettings({ openBeforeMinutes: 2 }));
    const secondStore = createStore(createMockSettings({ openBeforeMinutes: 7 }));
    const first = createSettingsFacade(firstStore);
    const second = createSettingsFacade(secondStore);

    await first.load();
    await second.load();
    await first.update({ openBeforeMinutes: 3 });
    await second.save(createMockSettings({ openBeforeMinutes: 9 }));

    expect(first.get().openBeforeMinutes).toBe(3);
    expect(second.get().openBeforeMinutes).toBe(9);
    expect(firstStore.update).toHaveBeenCalledWith({ openBeforeMinutes: 3 });
    expect(secondStore.save).toHaveBeenCalledWith(expect.objectContaining({ openBeforeMinutes: 9 }));
  });
});
