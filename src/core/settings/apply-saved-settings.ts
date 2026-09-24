import type { SettingsUpdateResult } from '@shared/schemas/settings-update'

/** Persistence has succeeded: report a later runtime failure without claiming
 * the configuration was lost or asking the client to repeat the write. */
export async function applySavedSettings(
  saved: SettingsUpdateResult,
  apply: () => Promise<SettingsUpdateResult>,
  onError: (error: unknown) => void
): Promise<SettingsUpdateResult> {
  try {
    return await apply()
  } catch (error) {
    onError(error)
    return { ...saved, applicationFailed: true }
  }
}
