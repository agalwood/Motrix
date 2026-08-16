import type { SupportedLocale } from '@shared/constants/locales'
import enUS from '@shared/locales/en-US.json'
import zhCN from '@shared/locales/zh-CN.json'
import zhTW from '@shared/locales/zh-TW.json'

export const I18N_RESOURCES = {
  'en-US': { translation: enUS },
  'zh-CN': { translation: zhCN },
  'zh-TW': { translation: zhTW },
} satisfies Record<SupportedLocale, { translation: Record<string, unknown> }>
