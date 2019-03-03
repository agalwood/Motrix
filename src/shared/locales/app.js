import appLocaleEnUS from '@shared/locales/en-US'
import appLocalePtBr from '@shared/locales/pt-BR'
import appLocaleZhCN from '@shared/locales/zh-CN'
import appLocaleZhTW from '@shared/locales/zh-TW'
import appLocaleTrTR from '@shared/locales/tr'
import appLocaleFrFR from '@shared/locales/fr'

// Please keep the locale key in alphabetical order.
const resources = {
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
