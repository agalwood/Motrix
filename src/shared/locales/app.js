import appLocaleEnUS from '@shared/locales/en-US'
import appLocaleZhCN from '@shared/locales/zh-CN'
import appLocaleTrTR from '@shared/locales/tr'
import appLocaleFrFR from '@shared/locales/fr'

const resources = {
  'en-US': {
    translation: {
      ...appLocaleEnUS
    }
  },
  'zh-CN': {
    translation: {
      ...appLocaleZhCN
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
