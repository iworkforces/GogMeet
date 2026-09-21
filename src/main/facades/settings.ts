import type { AppSettings } from "../../domain/entities/settings.js";
import type { Result } from "../../domain/entities/result.js";
import { createLoadSettings } from "../application/use-cases/load-settings.js";
import { createUpdateSettings } from "../application/use-cases/update-settings.js";
import { createGetSettings } from "../application/use-cases/get-settings.js";
import {
  createJsonSettingsStore,
  type JsonSettingsStore,
} from "../infrastructure/settings/json-settings-store.js";

export interface SettingsFacade {
  readonly load: () => Promise<Result<AppSettings, string>>;
  readonly save: (settings: AppSettings) => Promise<void>;
  readonly get: () => AppSettings;
  readonly update: (partial: Partial<AppSettings>) => Promise<AppSettings>;
}

export function createSettingsFacade(
  store: JsonSettingsStore = createJsonSettingsStore(),
): SettingsFacade {
  const load = createLoadSettings(store);
  const update = createUpdateSettings(store);
  const get = createGetSettings(store);

  return {
    load(): Promise<Result<AppSettings, string>> {
      return load.execute();
    },

    save(settings: AppSettings): Promise<void> {
      return store.save(settings);
    },

    get(): AppSettings {
      return get.execute();
    },

    update(partial: Partial<AppSettings>): Promise<AppSettings> {
      return update.execute(partial);
    },
  };
}
