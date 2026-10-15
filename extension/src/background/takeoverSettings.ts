import type { TakeoverConfigStore } from '@/background/TakeoverConfigStore'
import type { TakeoverSettings } from '@/shared/takeover'

export function createTakeoverSettingsHandlers(
  store: TakeoverConfigStore,
  hasPairedBackend: () => Promise<boolean>
) {
  const requirePairing = async (enabled: boolean): Promise<void> => {
    if (enabled && !(await hasPairedBackend())) {
      throw new Error('takeover.pairing-required')
    }
  }
  return {
    patchEnabled: async ({
      enabled,
      consentAckVersion,
    }: {
      enabled: boolean
      consentAckVersion?: number
    }) => {
      await requirePairing(enabled)
      return store.patchEnabled(enabled, consentAckVersion)
    },
    set: async (settings: TakeoverSettings) => {
      await requirePairing(settings.enabled)
      await store.patchTakeoverSettings(settings)
      return { ok: true } as const
    },
  }
}
