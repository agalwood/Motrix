import type { SupportedLocale } from '@shared/constants/locales'
import de from '@shared/locales/de.json'
import enUS from '@shared/locales/en-US.json'
import es from '@shared/locales/es.json'
import fr from '@shared/locales/fr.json'
import id from '@shared/locales/id.json'
import it from '@shared/locales/it.json'
import ja from '@shared/locales/ja.json'
import ko from '@shared/locales/ko.json'
import pl from '@shared/locales/pl.json'
import ptBR from '@shared/locales/pt-BR.json'
import ru from '@shared/locales/ru.json'
import tr from '@shared/locales/tr.json'
import vi from '@shared/locales/vi.json'
import zhCN from '@shared/locales/zh-CN.json'
import zhTW from '@shared/locales/zh-TW.json'

export const I18N_RESOURCES = {
  de: { translation: de },
  'en-US': { translation: enUS },
  es: { translation: es },
  fr: { translation: fr },
  id: { translation: id },
  it: { translation: it },
  ja: { translation: ja },
  ko: { translation: ko },
  pl: { translation: pl },
  'pt-BR': { translation: ptBR },
  ru: { translation: ru },
  tr: { translation: tr },
  vi: { translation: vi },
  'zh-CN': { translation: zhCN },
  'zh-TW': { translation: zhTW },
} satisfies Record<SupportedLocale, { translation: Record<string, unknown> }>
