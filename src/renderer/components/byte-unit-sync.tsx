import { setByteUnitSystem } from '@renderer/hooks/use-byte-format'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  byteUnitSystemSchema,
  DEFAULT_BYTE_UNIT_PREFERENCE,
} from '@shared/schemas/byte-unit-system'
import type { AppSettings } from '@shared/types/settings'
import { useEffect } from 'react'

export function ByteUnitSync() {
  useEffect(() => {
    const platform =
      transport.platform === 'web'
        ? (globalThis.navigator?.platform ?? '')
        : (transport.platform ?? '')
    let active = true
    let generation = 0
    const reconcile = () => {
      const requestGeneration = ++generation
      void transport
        .invoke(Queries.GetSettings)
        .then((data) => {
          if (!active || requestGeneration !== generation) return
          const settings = data as AppSettings | undefined
          const parsed = byteUnitSystemSchema.safeParse(
            settings?.app?.byteUnitSystem
          )
          setByteUnitSystem(
            parsed.success ? parsed.data : DEFAULT_BYTE_UNIT_PREFERENCE,
            platform
          )
        })
        .catch(() => {})
    }
    const onChange = (payload: unknown) => {
      const parsed = byteUnitSystemSchema.safeParse(
        (payload as { byteUnitSystem?: unknown } | null)?.byteUnitSystem
      )
      if (!parsed.success) return
      generation += 1
      setByteUnitSystem(parsed.data, platform)
    }
    transport.on(Events.ByteUnitSystemChanged, onChange)
    const stopConnectionSync = transport.onConnectionChange?.((event) => {
      if (event.state === 'connected') reconcile()
    })
    reconcile()
    return () => {
      active = false
      generation += 1
      transport.off(Events.ByteUnitSystemChanged, onChange)
      stopConnectionSync?.()
    }
  }, [])
  return null
}
