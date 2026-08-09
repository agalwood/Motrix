import { DirectionProvider } from '@renderer/components/ui/direction'
import {
  getLocaleDirection,
  resolveSupportedLocale,
} from '@shared/constants/locales'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

/** Keep Base UI keyboard/navigation semantics aligned with the document dir. */
export function LocaleDirectionProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation()
  const locale = resolveSupportedLocale(i18n.resolvedLanguage ?? i18n.language)

  return (
    <DirectionProvider direction={getLocaleDirection(locale)}>
      {children}
    </DirectionProvider>
  )
}
