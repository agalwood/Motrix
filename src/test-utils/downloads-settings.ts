import { DEFAULT_APP_SETTINGS } from '@shared/schemas/app-settings'
import { downloadsSettingsSchema } from '@shared/schemas/downloads-settings'
import { DEFAULT_ENGINE_SETTINGS } from '@shared/schemas/engine-settings'
import { DEFAULT_SPEED_LIMIT_SETTINGS } from '@shared/schemas/speed-limit'
export const TEST_DOWNLOADS_REVISION = '00000000-0000-4000-8000-000000000001'
export function downloadsSettingsResult(
  settings: { app?: object; engine?: object; speedLimit?: object } = {},
  preferences = { favorites: [] as string[], recent: [] as string[] }
) {
  return {
    ok: true as const,
    value: {
      revision: TEST_DOWNLOADS_REVISION,
      settings: downloadsSettingsSchema.parse({
        app: {
          ...DEFAULT_APP_SETTINGS,
          defaultSaveDir: '/downloads',
          ...settings.app,
        },
        engine: { ...DEFAULT_ENGINE_SETTINGS, ...settings.engine },
        speedLimit: settings.speedLimit ?? DEFAULT_SPEED_LIMIT_SETTINGS,
      }),
      directoryPreferences: preferences,
    },
    update: { saved: true, requiresRestart: false, changedRestartKeys: [] },
  }
}
