import { DEFAULT_APP_SETTINGS } from '@shared/schemas/app-settings'
import type { DirectoryPreferences } from '@shared/schemas/directory-preferences'
import {
  type GeneralSettingsApp,
  GeneralSettingsAppSchema,
  type GeneralSettingsSnapshot,
} from '@shared/schemas/general-settings'

export const TEST_GENERAL_REVISION = '00000000-0000-4000-8000-000000000001'
export function generalSettingsSnapshot(
  directoryPreferences: DirectoryPreferences = { favorites: [], recent: [] },
  app: Partial<GeneralSettingsApp> = {},
  revision = TEST_GENERAL_REVISION
): GeneralSettingsSnapshot {
  return {
    revision,
    app: GeneralSettingsAppSchema.parse({
      ...DEFAULT_APP_SETTINGS,
      defaultSaveDir: '/downloads',
      ...app,
    }),
    directoryPreferences,
  }
}
