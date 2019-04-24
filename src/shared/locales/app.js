import appLocaleDeDE from '@shared/locales/de'
import appLocaleEnUS from '@shared/locales/en-US'
import appLocaleFrFR from '@shared/locales/fr'
import appLocaleJaJA from '@shared/locales/ja'
import appLocalePtBr from '@shared/locales/pt-BR'
import appLocaleTrTR from '@shared/locales/tr'
import appLocaleZhCN from '@shared/locales/zh-CN'
import appLocaleZhTW from '@shared/locales/zh-TW'

// Please keep the locale key in alphabetical order.
const resources = {
  'de': {
    translation: {
      ...appLocaleDeDE
    }
  },
  'en-US': {
    translation: {
      ...appLocaleEnUS
    }
  },
  'fr': {
    translation: {
      ...appLocaleFrFR
    }
  },
    'ja': {
    translation: {
      ...appLocaleJaJA
    }
  },
  'pt-BR': {
    translation: {
      ...appLocalePtBr
    }
  },
  'tr': {
    translation: {
      ...appLocaleTrTR
    }
  },
  'zh-CN': {
    translation: {
      ...appLocaleZhCN
    }
  },
  'zh-TW': {
    translation: {
      ...appLocaleZhTW
    }
  }
}

export default resources
