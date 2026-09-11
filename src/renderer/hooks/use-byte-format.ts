import {
  type ByteUnitPreference,
  type ByteUnitSystem,
  DEFAULT_BYTE_UNIT_PREFERENCE,
  resolveByteUnitSystem,
} from '@shared/schemas/byte-unit-system'
import {
  type ByteValue,
  formatBytes,
  formatSpeed,
} from '@shared/utils/format-bytes'
import { useSyncExternalStore } from 'react'

function createFormatters(unitSystem: ByteUnitSystem) {
  return {
    unitSystem,
    formatBytes: (bytes: ByteValue) => formatBytes(bytes, { unitSystem }),
    formatSpeed: (bytes: ByteValue) => formatSpeed(bytes, unitSystem),
  }
}

const formatters = {
  decimal: createFormatters('decimal'),
  binary: createFormatters('binary'),
}
const listeners = new Set<() => void>()
const devicePlatform = () => globalThis.navigator?.platform ?? ''
let current =
  formatters[
    resolveByteUnitSystem(DEFAULT_BYTE_UNIT_PREFERENCE, devicePlatform())
  ]
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
  if (current === formatters[value]) return
  current = formatters[value]
  for (const listener of listeners) listener()
}

export function useByteFormat() {
  return useSyncExternalStore(subscribe, getSnapshot)
}
