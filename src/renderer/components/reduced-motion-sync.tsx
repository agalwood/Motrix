import {
  setAppReduceMotion,
  useReducedMotion,
} from '@renderer/lib/reduced-motion'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/app-settings'
import type { AppSettings } from '@shared/types/settings'
import { useEffect, useLayoutEffect } from 'react'

export function ReducedMotionSync({ syncSettings = true }) {
  const reducedMotion = useReducedMotion()

  useLayoutEffect(() => {
    document.documentElement.dataset.reducedMotion = String(reducedMotion)
  }, [reducedMotion])

  useEffect(() => {
    if (!syncSettings) return
    let active = true
    let generation = 0

    const reconcile = () => {
      const requestGeneration = ++generation
      void transport
        .invoke(Queries.GetSettings)
        .then((data) => {
          if (!active || requestGeneration !== generation) return
          const settings = data as AppSettings | undefined
          setAppReduceMotion(
            settings?.app?.reduceMotion ?? DEFAULT_APP_SETTINGS.reduceMotion
          )
        })
        .catch(() => {})
    }
    const onReducedMotionChanged = (payload: unknown) => {
      const { reduceMotion } = (payload ?? {}) as { reduceMotion?: unknown }
      if (typeof reduceMotion !== 'boolean') return
      generation += 1
      setAppReduceMotion(reduceMotion)
    }

    // Subscribe first so a live update wins over an older settings snapshot.
    transport.on(Events.ReducedMotionChanged, onReducedMotionChanged)
    const stopConnectionSync = transport.onConnectionChange?.((event) => {
      if (event.state === 'connected') reconcile()
    })
    reconcile()
    return () => {
      active = false
      generation += 1
      transport.off(Events.ReducedMotionChanged, onReducedMotionChanged)
      stopConnectionSync?.()
    }
  }, [syncSettings])

  return null
}
