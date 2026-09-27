import type { SupportedLocale } from '@shared/constants/locales'
import ar from '@shared/locales/ar.json'
import bg from '@shared/locales/bg.json'
import ca from '@shared/locales/ca.json'
import de from '@shared/locales/de.json'
import el from '@shared/locales/el.json'
import enUS from '@shared/locales/en-US.json'
import es from '@shared/locales/es.json'
import fa from '@shared/locales/fa.json'
import fr from '@shared/locales/fr.json'
import id from '@shared/locales/id.json'
import it from '@shared/locales/it.json'
import ja from '@shared/locales/ja.json'
import ko from '@shared/locales/ko.json'
import nb from '@shared/locales/nb.json'
import nl from '@shared/locales/nl.json'
import pl from '@shared/locales/pl.json'
import ptBR from '@shared/locales/pt-BR.json'
import ro from '@shared/locales/ro.json'
import ru from '@shared/locales/ru.json'
import th from '@shared/locales/th.json'
import tr from '@shared/locales/tr.json'
import uk from '@shared/locales/uk.json'
import vi from '@shared/locales/vi.json'
import zhCN from '@shared/locales/zh-CN.json'
import zhTW from '@shared/locales/zh-TW.json'

export const I18N_RESOURCES = {
  ar: { translation: ar },
  bg: { translation: bg },
  ca: { translation: ca },
  de: { translation: de },
  el: { translation: el },
  'en-US': { translation: enUS },
  es: { translation: es },
  fa: { translation: fa },
  fr: { translation: fr },
  id: { translation: id },
  it: { translation: it },
  ja: { translation: ja },
  ko: { translation: ko },
  nb: { translation: nb },
  nl: { translation: nl },
  pl: { translation: pl },
  'pt-BR': { translation: ptBR },
  ro: { translation: ro },
  ru: { translation: ru },
  th: { translation: th },
  tr: { translation: tr },
  uk: { translation: uk },
  vi: { translation: vi },
  'zh-CN': { translation: zhCN },
  'zh-TW': { translation: zhTW },
} satisfies Record<SupportedLocale, { translation: Record<string, unknown> }>
