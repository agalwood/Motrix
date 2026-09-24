import { onOperatorSessionLost } from '@renderer/lib/operator-auth'
import {
  onSettingsRefresh,
  type SettingsReader,
} from '@renderer/lib/settings-refresh'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { SpeedLimitReason, TurtleState } from '@shared/types/settings'
import { useEffect, useState } from 'react'

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

  useEffect(() => {
    let disposed = false
    let generation = 0
    const apply = (next: SpeedLimitStateView) => {
      if (disposed) return
      cachedState = next
      setState(next)
    }
    const reconcile = async (
      read: SettingsReader = (channel) => transport.invoke(channel)
    ) => {
      const current = ++generation
      const next = await read(Queries.GetSpeedLimitState)
      if (next && current === generation) apply(next as SpeedLimitStateView)
    }
    const refresh = () => void reconcile().catch(() => {})
    const onChange = (...args: unknown[]) => {
      // A live mode change supersedes any earlier in-flight snapshot.
      generation++
      apply(args[0] as SpeedLimitStateView)
    }
    transport.on(Events.SpeedLimitChanged, onChange)
    const stopSettingsSync = onSettingsRefresh(reconcile)
    const removeConnectionListener = transport.onConnectionChange?.((event) => {
      if (event.state === 'connected') void refresh()
    })
    window.addEventListener('focus', refresh)
    void refresh()
    return () => {
      disposed = true
      transport.off(Events.SpeedLimitChanged, onChange)
      removeConnectionListener?.()
      stopSettingsSync()
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return state
}

onOperatorSessionLost(() => {
  cachedState = null
})
