import { transport } from '@renderer/lib/transport'
import {
  removeGlobalCssVar,
  setGlobalCssVar,
} from '@shared/constants/css-variables'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { AppSettings } from '@shared/types/settings'
import { useEffect } from 'react'

export function applyFontFamily(fontFamily?: string | null): void {
  if (!fontFamily) {
    removeGlobalCssVar('--app-font-family')
    return
  }

  // Extract only the primary font family before any comma and collapse whitespace
  const customFont = fontFamily.split(',')[0].replace(/\s+/g, ' ').trim()

  if (!customFont) {
    removeGlobalCssVar('--app-font-family')
    return
  }

  const lower = customFont.toLowerCase()
  const isQuoted =
    (customFont.startsWith('"') && customFont.endsWith('"')) ||
    (customFont.startsWith("'") && customFont.endsWith("'"))
  const isGeneric = [
    'sans-serif',
    'serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
  ].includes(lower)

  const formattedFont = isQuoted || isGeneric ? customFont : `"${customFont}"`

  setGlobalCssVar(
    '--app-font-family',
    `${formattedFont}, "Inter Variable", sans-serif`
  )
}

function fontFromSettings(payload: unknown): string | null | undefined {
  if (typeof payload !== 'object' || !payload) return undefined
  if ('fontFamily' in payload) {
    return (payload as { fontFamily: string | null }).fontFamily
  }
  const app = (payload as { app?: unknown }).app
  if (app && typeof app === 'object' && 'fontFamily' in app) {
    return (app as { fontFamily: string | null }).fontFamily
  }
  return undefined
}

export function FontSync() {
  useEffect(() => {
    let active = true
    let generation = 0

    const queueFont = (
      fontFamily: string | null | undefined,
      fontGeneration: number
    ): void => {
      if (!active || fontGeneration !== generation) return
      applyFontFamily(fontFamily)
    }

    const onSettingsChanged = (payload: unknown): void => {
      const font = fontFromSettings(payload)
      if (font === undefined) return
      const fontGeneration = ++generation
      queueFont(font, fontGeneration)
    }

    const reconcileHostFont = (): void => {
      const fontGeneration = ++generation
      void transport
        .invoke(Queries.GetSettings)
        .then((state) => {
          if (!active || fontGeneration !== generation) return
          const settings = state as AppSettings | undefined
          const font = settings?.app?.fontFamily
          queueFont(font, fontGeneration)
        })
        .catch(() => {})
    }

    transport.on(Events.SettingsChanged, onSettingsChanged)

    const stopConnectionSync =
      transport.platform === 'web'
        ? transport.onConnectionChange?.((event) => {
            if (event.state === 'connected') reconcileHostFont()
          })
        : undefined

    if (transport.platform !== 'web') reconcileHostFont()

    return () => {
      active = false
      generation += 1
      transport.off(Events.SettingsChanged, onSettingsChanged)
      stopConnectionSync?.()
    }
  }, [])
  return null
}
