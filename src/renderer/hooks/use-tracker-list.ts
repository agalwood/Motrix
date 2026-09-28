import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { CuratedTrackerList } from '@shared/types/tracker'
import { useState } from 'react'
import { useTransportMirror } from './use-transport-mirror'

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

  useTransportMirror({
    events: [Events.TrackerListUpdated, Events.TrackerSyncStatusChanged],
    refreshOnSettingsSave: true,
    load: async (stale, read) => {
      try {
        setIsLoading(true)
        const data = await read(Queries.GetTrackerList)
        if (stale()) return
        setList(data as CuratedTrackerList)
        setError(null)
      } catch (e) {
        if (!stale()) setError(e instanceof Error ? e.message : 'Unknown error')
        throw e
      } finally {
        if (!stale()) setIsLoading(false)
      }
    },
  })

  return { list, isLoading, error, lastSyncAt: list.lastSyncAt }
}
