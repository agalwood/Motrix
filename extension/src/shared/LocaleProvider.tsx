import { DirectionProvider } from '@base-ui/react/direction-provider'
import { type ReactNode, useEffect, useLayoutEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { extensionBrowser } from '@/shared/browser'
import { initI18n } from '@/shared/i18n'
import { LOCALE_KEY } from '@/shared/localeStore'

/** Apply locale direction only to extension pages, never to content scripts. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const direction = i18n.dir(language)

  useLayoutEffect(() => {
    document.documentElement.lang = language
    document.documentElement.dir = direction
  }, [language, direction])

  useEffect(() => {
    const onChange = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && LOCALE_KEY in changes) void initI18n()
    }
    extensionBrowser.storage.onChanged.addListener(onChange)
    return () => extensionBrowser.storage.onChanged.removeListener(onChange)
  }, [])

  return <DirectionProvider direction={direction}>{children}</DirectionProvider>
}
