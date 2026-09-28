import {
  languageFromState,
  type RendererWindowId,
} from '@renderer/lib/bootstrap-locale'
import { applyRendererLocale } from '@renderer/lib/i18n'
import {
  onSettingsRefresh,
  type SettingsReader,
} from '@renderer/lib/settings-refresh'
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

// Hydrate authenticated web pages and keep every renderer in sync with host
// events and the authoritative readback after a local settings save.
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
    ): Promise<void> => {
      const pending = applicationTail.then(async () => {
        if (!active || localeGeneration !== generation) return
        await applyRendererLocale(locale)
      })
      applicationTail = pending.catch(() => {})
      return pending
    }

    const onLocaleChanged = (payload: unknown): void => {
      const locale = localeFromEvent(payload)
      if (!locale) return
      const localeGeneration = ++generation
      void queueLocale(locale, localeGeneration).catch(() => {})
    }

    const reconcileHostLocale = async (
      read: SettingsReader = (channel) => transport.invoke(channel)
    ): Promise<void> => {
      const localeGeneration = ++generation
      const state = await read(
        windowId === 'onboarding'
          ? Queries.GetDisclaimerState
          : Queries.GetSettings
      )
      if (!active || localeGeneration !== generation) return
      const locale = languageFromState(windowId, state)
      if (!isSupportedLocale(locale)) return
      await queueLocale(locale, localeGeneration)
    }

    const refresh = () => void reconcileHostLocale().catch(() => {})

    // Subscribe before starting a query so a newer live/buffered event wins
    // over any older authoritative snapshot returned by IPC/HTTP.
    transport.on(Events.LocaleChanged, onLocaleChanged)
    const stopConnectionSync =
      transport.platform === 'web'
        ? transport.onConnectionChange?.((event) => {
            if (event.state === 'connected') refresh()
          })
        : undefined
    const stopSettingsSync = onSettingsRefresh(reconcileHostLocale)
    // The web root mounts after authentication. Its HTTP snapshot must not
    // depend on the event socket ever connecting (for example behind a proxy).
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      generation += 1
      transport.off(Events.LocaleChanged, onLocaleChanged)
      stopConnectionSync?.()
      stopSettingsSync()
      window.removeEventListener('focus', refresh)
    }
  }, [windowId])

  return null
}
