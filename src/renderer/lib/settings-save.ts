import { toast } from '@renderer/components/ui/toast'
import { i18n } from '@renderer/lib/i18n'
import { refreshRendererSettings } from '@renderer/lib/settings-refresh'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import {
  type SettingsUpdateResult,
  settingsUpdateResultSchema,
} from '@shared/schemas/settings-update'

const listeners = new Set<(result: SettingsUpdateResult) => void>()
const SYNC_WARNING_ID = 'settings-sync-failed'
let syncRevision = 0

export function onSettingsSaved(
  listener: (result: SettingsUpdateResult) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export async function synchronizeSavedSettings(): Promise<void> {
  const revision = ++syncRevision
  try {
    await refreshRendererSettings()
    if (revision !== syncRevision) return
    toast.close(SYNC_WARNING_ID)
  } catch {
    if (revision !== syncRevision) return
    toast.close(SYNC_WARNING_ID)
    toast.add({
      id: SYNC_WARNING_ID,
      type: 'warning',
      title: i18n.t('settings.feedback.syncFailedTitle'),
      description: i18n.t('settings.feedback.syncFailedBody'),
      timeout: 0,
      actionProps: {
        children: i18n.t('settings.feedback.retrySync'),
        onClick: () => void synchronizeSavedSettings(),
      },
    })
  }
}

/** A failed readback must never turn a committed write into a failed save. */
export async function saveSettings(
  patch: unknown
): Promise<SettingsUpdateResult> {
  const response = await transport.invoke(Commands.UpdateSettings, patch)
  const result = settingsUpdateResultSchema.parse(response)
  await synchronizeSavedSettings()
  for (const listener of listeners) listener(result)
  if (result.applicationFailed) {
    toast.add({
      type: 'warning',
      title: i18n.t('settings.feedback.applyFailedTitle'),
      description: i18n.t('settings.feedback.applyFailedBody'),
      timeout: 0,
    })
  }
  if (result.requiresAppRestart && transport.platform !== 'web') {
    toast.add({
      type: 'info',
      title: i18n.t('settings.feedback.appRestartTitle'),
      description: i18n.t('settings.feedback.appRestartBody'),
      timeout: 0,
    })
  }
  return result
}
