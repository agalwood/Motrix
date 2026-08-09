import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { SpeedLimitReason, TurtleState } from '@shared/types/settings'
import { useCallback, useEffect, useState } from 'react'

export interface SpeedLimitStateView {
  turtle: TurtleState
  effective: { download: number; upload: number }
  activeReason: SpeedLimitReason
}

const FALLBACK: SpeedLimitStateView = {
  turtle: 'off',
  effective: { download: 0, upload: 0 },
  activeReason: 'none',
}

// Module-level cache of the last-known state. The dashboard route unmounts on
// every navigation (react-router <Outlet/>), so without this each remount would
// re-render the FALLBACK first and then async-correct to the real mode — which
// the tile's `transition-colors` turns into a visible unlimited->real animation.
// Seeding the initial state from the cache makes the first paint already correct.
let cachedState: SpeedLimitStateView | null = null

export function useSpeedLimitState(): SpeedLimitStateView {
  const [state, setState] = useState<SpeedLimitStateView>(
    () => cachedState ?? FALLBACK
  )

  const apply = useCallback((next: SpeedLimitStateView) => {
    cachedState = next
    setState(next)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const s = await transport.invoke(Queries.GetSpeedLimitState)
      if (s) apply(s as SpeedLimitStateView)
    } catch {
      /* next event will retry */
    }
  }, [apply])

  useEffect(() => {
    refresh()
    const onChange = (...args: unknown[]) => {
      apply(args[0] as SpeedLimitStateView)
    }
    transport.on(Events.SpeedLimitChanged, onChange)
    return () => {
      transport.off(Events.SpeedLimitChanged, onChange)
    }
  }, [refresh, apply])

  return state
}
