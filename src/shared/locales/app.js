import appLocaleEnUS from '@shared/locales/en-US'
import appLocalePtBr from '@shared/locales/pt-BR'
import appLocaleZhCN from '@shared/locales/zh-CN'
import appLocaleZhTW from '@shared/locales/zh-TW'
import appLocaleTrTR from '@shared/locales/tr'
import appLocaleFrFR from '@shared/locales/fr'

const resources = {
  'en-US': {
    translation: {
      ...appLocaleEnUS
    }
  },
  'pt-BR': {
    translation: {
      ...appLocalePtBr
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
  },
  'tr': {
    translation: {
      ...appLocaleTrTR
    }
  },
  'fr': {
    translation: {
      ...appLocaleFrFR
    }
  }
}

export default resources
