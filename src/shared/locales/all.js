import eleLocaleEn from 'element-ui/lib/locale/lang/en'
import eleLocalePtBR from 'element-ui/lib/locale/lang/pt-br'
import eleLocaleZhCN from 'element-ui/lib/locale/lang/zh-CN'
import eleLocaleZhTW from 'element-ui/lib/locale/lang/zh-TW'
import eleLocaleTr from 'element-ui/lib/locale/lang/tr-TR'
import eleLocaleFr from 'element-ui/lib/locale/lang/fr'
import appLocaleEnUS from '@shared/locales/en-US'
import appLocalePtBR from '@shared/locales/pt-BR'
import appLocaleZhCN from '@shared/locales/zh-CN'
import appLocaleZhTW from '@shared/locales/zh-TW'
import appLocaleTr from '@shared/locales/tr'
import appLocaleFr from '@shared/locales/fr'

const resources = {
  'en-US': {
    translation: {
      ...eleLocaleEn,
      ...appLocaleEnUS
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
  },
  'fr': {
    translation: {
      ...eleLocaleFr,
      ...appLocaleFr
    }
  }
}

export default resources
