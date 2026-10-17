import { useTransportMirror } from '@renderer/hooks/use-transport-mirror'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { legacyImportNavigationSchema } from '@shared/schemas/legacy-import'
import { useState } from 'react'
import { useLegacyImportSidebar } from './sidebar-preference'

export function useLegacyImportNavigation() {
  const [detected, setDetected] = useState(false)
  const dismissed = useLegacyImportSidebar((state) => state.dismissed)
  useTransportMirror({
    events: [Events.LegacyImportNavigationChanged],
    load: async (stale, read) => {
      if (__MOTRIX_TARGET__ !== 'electron') return
      const state = legacyImportNavigationSchema.parse(
        await read(Queries.GetLegacyImportNavigation)
      )
      if (!stale()) setDetected(state.detected)
    },
  })
  return { visible: detected && !dismissed }
}
