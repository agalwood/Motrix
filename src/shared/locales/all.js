import eleLocaleEn from 'element-ui/lib/locale/lang/en'
import eleLocaleFr from 'element-ui/lib/locale/lang/fr'
import eleLocalePtBR from 'element-ui/lib/locale/lang/pt-br'
import eleLocaleTr from 'element-ui/lib/locale/lang/tr-TR'
import eleLocaleZhCN from 'element-ui/lib/locale/lang/zh-CN'
import eleLocaleZhTW from 'element-ui/lib/locale/lang/zh-TW'
import appLocaleEnUS from '@shared/locales/en-US'
import appLocaleFr from '@shared/locales/fr'
import appLocalePtBR from '@shared/locales/pt-BR'
import appLocaleTr from '@shared/locales/tr'
import appLocaleZhCN from '@shared/locales/zh-CN'
import appLocaleZhTW from '@shared/locales/zh-TW'

// Please keep the locale key in alphabetical order.
const resources = {
  'en-US': {
    translation: {
      ...eleLocaleEn,
      ...appLocaleEnUS
    }
  },
  'fr': {
    translation: {
      ...eleLocaleFr,
      ...appLocaleFr
    }
  },
  'pt-BR': {
    translation: {
      ...eleLocalePtBR,
      ...appLocalePtBR
    }
  },
  'tr': {
    translation: {
      ...eleLocaleTr,
      ...appLocaleTr
    }
  },
  'zh-CN': {
    translation: {
      ...eleLocaleZhCN,
      ...appLocaleZhCN
    }
  },
  'zh-TW': {
    translation: {
      ...eleLocaleZhTW,
      ...appLocaleZhTW
    }
  }
}

export default resources
