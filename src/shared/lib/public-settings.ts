import { publicEngineSettingsSchema } from '../schemas/public-engine-settings'
import type { AppSettings } from '../types/settings'

export function publicSettings(settings: AppSettings) {
  return {
    ...settings,
    engine: publicEngineSettingsSchema.parse(settings.engine),
  }
}
export type PublicSettings = ReturnType<typeof publicSettings>
