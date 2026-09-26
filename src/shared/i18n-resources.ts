import type { SupportedLocale } from '@shared/constants/locales'
import de from '@shared/locales/de.json'
import enUS from '@shared/locales/en-US.json'
import es from '@shared/locales/es.json'
import fr from '@shared/locales/fr.json'
import ja from '@shared/locales/ja.json'
import zhCN from '@shared/locales/zh-CN.json'
import zhTW from '@shared/locales/zh-TW.json'

export const I18N_RESOURCES = {
  de: { translation: de },
  'en-US': { translation: enUS },
  es: { translation: es },
  fr: { translation: fr },
  ja: { translation: ja },
  'zh-CN': { translation: zhCN },
  'zh-TW': { translation: zhTW },
} satisfies Record<SupportedLocale, { translation: Record<string, unknown> }>
