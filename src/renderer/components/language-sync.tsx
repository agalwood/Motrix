import type { RendererWindowId } from '@renderer/lib/bootstrap-locale'
import { applyRendererLocale } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { isSupportedLocale } from '@shared/constants/locales'
import { Events, type LocaleChangedPayload } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { useEffect } from 'react'

function localeFromEvent(
  payload: unknown
): LocaleChangedPayload['language'] | undefined {
  if (payload && typeof payload === 'object' && 'language' in payload) {
    const { language } = payload
    return isSupportedLocale(language) ? language : undefined
  }
  return undefined
}

// Initial locale hydration happens before createRoot. This component keeps
// every renderer window in sync with later changes broadcast by the host.
export function LanguageSync({
  windowId = 'main',
}: {
  windowId?: RendererWindowId
}) {
  useEffect(() => {
    let active = true
    let generation = 0
    let applicationTail = Promise.resolve()

    const queueLocale = (
      locale: LocaleChangedPayload['language'],
      localeGeneration: number
    ): void => {
      applicationTail = applicationTail
        .then(async () => {
          if (!active || localeGeneration !== generation) return
          await applyRendererLocale(locale)
        })
        // A malformed or temporarily unavailable renderer resource must not
        // surface as an unhandled rejection or poison later locale updates.
        .catch(() => {})
    }

    const onLocaleChanged = (payload: unknown): void => {
      const locale = localeFromEvent(payload)
      if (!locale) return
      const localeGeneration = ++generation
      queueLocale(locale, localeGeneration)
    }

    const reconcileHostLocale = (): void => {
      const localeGeneration = ++generation
      void transport
        .invoke(
          windowId === 'onboarding'
            ? Queries.GetDisclaimerState
            : Queries.GetSettings
        )
        .then((state) => {
          if (!active || localeGeneration !== generation) return
          const locale =
            windowId === 'onboarding'
              ? (state as { language?: unknown } | undefined)?.language
              : (state as { app?: { language?: unknown } } | undefined)?.app
                  ?.language
          if (!isSupportedLocale(locale)) return
          queueLocale(locale, localeGeneration)
        })
        .catch(() => {})
    }

    // Subscribe before starting a query so a newer live/buffered event wins
    // over any older authoritative snapshot returned by IPC/HTTP.
    transport.on(Events.LocaleChanged, onLocaleChanged)
    const stopConnectionSync =
      transport.platform === 'web'
        ? transport.onConnectionChange?.((event) => {
            if (event.state === 'connected') reconcileHostLocale()
          })
        : undefined
    // Electron has no connection lifecycle. Reconcile once on mount as a
    // backstop for an event sent before forwarding/renderer startup; preload's
    // replay and the generation guard preserve newer live events.
    if (transport.platform !== 'web') reconcileHostLocale()
    return () => {
      active = false
      generation += 1
      transport.off(Events.LocaleChanged, onLocaleChanged)
      stopConnectionSync?.()
    }
  }, [windowId])

  return null
}
