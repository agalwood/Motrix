import { useSidebarColorState } from '@renderer/lib/sidebar-color'
import { systemAccentHue } from '@renderer/lib/system-accent-color'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { sidebarColorSchema } from '@shared/schemas/sidebar-color'
import type { AppSettings } from '@shared/types/settings'
import { useEffect, useState } from 'react'
import { useTransportMirror } from './use-transport-mirror'

export function useSidebarColor() {
  const color = useSidebarColorState((state) => state.preview ?? state.saved)
  const [systemAccent, setSystemAccent] = useState<string | null>(null)
  useTransportMirror({
    events: [Events.SystemAccentColorChanged],
    load: async (stale) => {
      const accent = await transport.invoke(Queries.GetSystemAccentColor)
      if (!stale()) {
        setSystemAccent(
          typeof accent === 'string' && /^#[\da-f]{6}$/i.test(accent)
            ? accent
            : null
        )
      }
    },
  })
  useTransportMirror({
    events: [Events.SidebarColorChanged],
    refreshOnSettingsSave: true,
    load: async (stale, read) => {
      const revision = useSidebarColorState.getState().revision
      const settings = (await read(Queries.GetSettings)) as
        | AppSettings
        | undefined
      if (stale() || revision !== useSidebarColorState.getState().revision)
        return
      useSidebarColorState.setState({
        saved: sidebarColorSchema
          .catch('gray')
          .parse(settings?.app?.sidebarColor),
      })
    },
  })
  useEffect(() => {
    const root = document.documentElement
    const hue = systemAccentHue(systemAccent)
    root.dataset.sidebarColor =
      color === 'auto' && hue === null ? 'gray' : color
    if (color === 'auto' && hue !== null)
      root.style.setProperty('--sidebar-hue', String(hue))
    else root.style.removeProperty('--sidebar-hue')
    if (systemAccent)
      root.style.setProperty('--system-accent-color', systemAccent)
    else root.style.removeProperty('--system-accent-color')
    return () => {
      delete root.dataset.sidebarColor
      root.style.removeProperty('--sidebar-hue')
      root.style.removeProperty('--system-accent-color')
    }
  }, [color, systemAccent])
}
