import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { CuratedTrackerList } from '@shared/types/tracker'
import { useCallback, useEffect, useState } from 'react'

const EMPTY: CuratedTrackerList = {
  effective: [],
  blacklist: [],
  healthMap: {},
  sourceMap: {},
  lastSyncAt: null,
  lastProbeAt: null,
}

export function useTrackerList() {
  const [list, setList] = useState<CuratedTrackerList>(EMPTY)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true)
      const data = await transport.invoke(Queries.GetTrackerList)
      setList(data as CuratedTrackerList)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const onUpdated = () => refresh()
    transport.on(Events.TrackerListUpdated, onUpdated)
    return () => transport.off(Events.TrackerListUpdated, onUpdated)
  }, [refresh])

  return { list, isLoading, error, lastSyncAt: list.lastSyncAt }
}
