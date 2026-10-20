import type { SupportedLocale } from '@shared/constants/locales'
import { operatorAdmin as enUS } from '@shared/locales/en-US.json'
import { operatorAdmin as zhCN } from '@shared/locales/zh-CN.json'

// Keep the CLI namespace small while preserving the application contract:
// English/Chinese are eager; every other bundled locale loads on demand.
export const OPERATOR_ADMIN_RESOURCES = {
  'en-US': { translation: { operatorAdmin: enUS } },
  'zh-CN': { translation: { operatorAdmin: zhCN } },
}

const loaders = {
  ar: () =>
    import('@shared/locales/ar.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  bg: () =>
    import('@shared/locales/bg.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  ca: () =>
    import('@shared/locales/ca.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  de: () =>
    import('@shared/locales/de.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  el: () =>
    import('@shared/locales/el.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  'en-US': async () => enUS,
  es: () =>
    import('@shared/locales/es.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  fa: () =>
    import('@shared/locales/fa.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  fr: () =>
    import('@shared/locales/fr.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  hu: () =>
    import('@shared/locales/hu.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  id: () =>
    import('@shared/locales/id.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  it: () =>
    import('@shared/locales/it.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  ja: () =>
    import('@shared/locales/ja.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  ko: () =>
    import('@shared/locales/ko.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  nb: () =>
    import('@shared/locales/nb.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  nl: () =>
    import('@shared/locales/nl.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  pl: () =>
    import('@shared/locales/pl.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  'pt-BR': () =>
    import('@shared/locales/pt-BR.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  ro: () =>
    import('@shared/locales/ro.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  ru: () =>
    import('@shared/locales/ru.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  th: () =>
    import('@shared/locales/th.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  tr: () =>
    import('@shared/locales/tr.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  uk: () =>
    import('@shared/locales/uk.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  vi: () =>
    import('@shared/locales/vi.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
  'zh-CN': async () => zhCN,
  'zh-TW': () =>
    import('@shared/locales/zh-TW.json').then(
      ({ operatorAdmin }) => operatorAdmin
    ),
} satisfies Record<SupportedLocale, () => Promise<typeof enUS>>

export function loadOperatorAdminLocale(
  locale: SupportedLocale
): Promise<typeof enUS> {
  return loaders[locale]()
}
