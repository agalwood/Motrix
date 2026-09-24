import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { AppSettings } from '@shared/types/settings'
import { useState } from 'react'
import { useTransportMirror } from './use-transport-mirror'

export function useLiquidGlass(): boolean {
  const [enabled, setEnabled] = useState(false)
  useTransportMirror({
    events: [Events.LiquidGlassChanged],
    refreshOnSettingsSave: true,
    load: async (stale, read) => {
      const settings = (await read(Queries.GetSettings)) as AppSettings
      if (!stale()) setEnabled(settings?.app?.liquidGlassEffect === true)
    },
  })
  return enabled
}
