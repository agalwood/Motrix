import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { GlobalStats } from '@shared/types/stats'
import { useCallback, useEffect, useState } from 'react'

export interface UseGlobalStatsResult {
  stats: GlobalStats | null
}

export function useGlobalStats(): UseGlobalStatsResult {
  const [stats, setStats] = useState<GlobalStats | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = (await transport.invoke(Queries.GetStats)) as GlobalStats
      setStats(data)
    } catch {
      /* next event will retry */
    }
  }, [])

  useEffect(() => {
    refresh()
    const onUpdate = (...args: unknown[]) => {
      setStats(args[0] as GlobalStats)
    }
    transport.on(Events.StatsUpdated, onUpdate)
    return () => {
      transport.off(Events.StatsUpdated, onUpdate)
    }
  }, [refresh])

  return { stats }
}
