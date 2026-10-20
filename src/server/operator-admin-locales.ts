import type { SupportedLocale } from '@shared/constants/locales'
import { operatorAdmin as ar } from '@shared/locales/ar.json'
import { operatorAdmin as bg } from '@shared/locales/bg.json'
import { operatorAdmin as ca } from '@shared/locales/ca.json'
import { operatorAdmin as de } from '@shared/locales/de.json'
import { operatorAdmin as el } from '@shared/locales/el.json'
import { operatorAdmin as en_US } from '@shared/locales/en-US.json'
import { operatorAdmin as es } from '@shared/locales/es.json'
import { operatorAdmin as fa } from '@shared/locales/fa.json'
import { operatorAdmin as fr } from '@shared/locales/fr.json'
import { operatorAdmin as hu } from '@shared/locales/hu.json'
import { operatorAdmin as id } from '@shared/locales/id.json'
import { operatorAdmin as it } from '@shared/locales/it.json'
import { operatorAdmin as ja } from '@shared/locales/ja.json'
import { operatorAdmin as ko } from '@shared/locales/ko.json'
import { operatorAdmin as nb } from '@shared/locales/nb.json'
import { operatorAdmin as nl } from '@shared/locales/nl.json'
import { operatorAdmin as pl } from '@shared/locales/pl.json'
import { operatorAdmin as pt_BR } from '@shared/locales/pt-BR.json'
import { operatorAdmin as ro } from '@shared/locales/ro.json'
import { operatorAdmin as ru } from '@shared/locales/ru.json'
import { operatorAdmin as th } from '@shared/locales/th.json'
import { operatorAdmin as tr } from '@shared/locales/tr.json'
import { operatorAdmin as uk } from '@shared/locales/uk.json'
import { operatorAdmin as vi } from '@shared/locales/vi.json'
import { operatorAdmin as zh_CN } from '@shared/locales/zh-CN.json'
import { operatorAdmin as zh_TW } from '@shared/locales/zh-TW.json'

// The server CLI needs only its own namespace. Named JSON imports let the
// bundler discard the application UI catalogs from the Server package.
export const OPERATOR_ADMIN_RESOURCES = {
  ar: { translation: { operatorAdmin: ar } },
  bg: { translation: { operatorAdmin: bg } },
  ca: { translation: { operatorAdmin: ca } },
  de: { translation: { operatorAdmin: de } },
  el: { translation: { operatorAdmin: el } },
  'en-US': { translation: { operatorAdmin: en_US } },
  es: { translation: { operatorAdmin: es } },
  fa: { translation: { operatorAdmin: fa } },
  fr: { translation: { operatorAdmin: fr } },
  hu: { translation: { operatorAdmin: hu } },
  id: { translation: { operatorAdmin: id } },
  it: { translation: { operatorAdmin: it } },
  ja: { translation: { operatorAdmin: ja } },
  ko: { translation: { operatorAdmin: ko } },
  nb: { translation: { operatorAdmin: nb } },
  nl: { translation: { operatorAdmin: nl } },
  pl: { translation: { operatorAdmin: pl } },
  'pt-BR': { translation: { operatorAdmin: pt_BR } },
  ro: { translation: { operatorAdmin: ro } },
  ru: { translation: { operatorAdmin: ru } },
  th: { translation: { operatorAdmin: th } },
  tr: { translation: { operatorAdmin: tr } },
  uk: { translation: { operatorAdmin: uk } },
  vi: { translation: { operatorAdmin: vi } },
  'zh-CN': { translation: { operatorAdmin: zh_CN } },
  'zh-TW': { translation: { operatorAdmin: zh_TW } },
} satisfies Record<
  SupportedLocale,
  { translation: { operatorAdmin: typeof en_US } }
>
