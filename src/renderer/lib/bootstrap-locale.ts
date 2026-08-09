import { applyRendererLocale } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALE_CODES,
  type SupportedLocale,
} from '@shared/constants/locales'
import { Queries } from '@shared/protocol/queries'

export type RendererWindowId = 'main' | 'add-task' | 'onboarding'

interface LanguageState {
  language?: unknown
}

interface SettingsState {
  app?: LanguageState
}

function languageFromState(
  windowId: RendererWindowId,
  state: unknown
): string | undefined {
  if (!state || typeof state !== 'object') return undefined

  const language =
    windowId === 'onboarding'
      ? (state as LanguageState).language
      : (state as SettingsState).app?.language
  return typeof language === 'string' ? language : undefined
}

export async function bootstrapRendererLocale(
  windowId: RendererWindowId,
  search = globalThis.location?.search ?? ''
): Promise<SupportedLocale> {
  const urlLocale = new URLSearchParams(search).get('locale')
  if (
    transport.platform !== 'web' &&
    SUPPORTED_LOCALE_CODES.some((locale) => locale === urlLocale)
  ) {
    return applyRendererLocale(urlLocale)
  }

  try {
    const state = await transport.invoke(
      windowId === 'onboarding'
        ? Queries.GetDisclaimerState
        : Queries.GetSettings
    )
    return await applyRendererLocale(
      languageFromState(windowId, state) ?? DEFAULT_LOCALE
    )
  } catch {
    return applyRendererLocale(DEFAULT_LOCALE)
  }
}
