import {
  type ByteUnitPreference,
  DEFAULT_BYTE_UNIT_PREFERENCE,
  resolveByteUnitSystem,
} from '@shared/schemas/byte-unit-system'
import { createLocalizedByteFormatter } from '@shared/utils/localized-byte-format'
import { useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

const listeners = new Set<() => void>()
const devicePlatform = () => globalThis.navigator?.platform ?? ''
let current = resolveByteUnitSystem(
  DEFAULT_BYTE_UNIT_PREFERENCE,
  devicePlatform()
)
const getSnapshot = () => current
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// A cache of the host setting; persistence belongs to UpdateSettings.
export function setByteUnitSystem(
  preference: ByteUnitPreference,
  platform = devicePlatform()
): void {
  const value = resolveByteUnitSystem(preference, platform)
  if (current === value) return
  current = value
  for (const listener of listeners) listener()
}

export function useByteFormat() {
  const unitSystem = useSyncExternalStore(subscribe, getSnapshot)
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en-US'
  return useMemo(
    () => createLocalizedByteFormatter(unitSystem, locale, t),
    [unitSystem, locale, t]
  )
}
