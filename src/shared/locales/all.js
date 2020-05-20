import eleLocaleCa from 'element-ui/lib/locale/lang/ca'
import eleLocaleDe from 'element-ui/lib/locale/lang/de'
import eleLocaleEn from 'element-ui/lib/locale/lang/en'
import eleLocaleEs from 'element-ui/lib/locale/lang/es'
import eleLocaleFa from 'element-ui/lib/locale/lang/fa'
import eleLocaleFr from 'element-ui/lib/locale/lang/fr'
import eleLocaleId from 'element-ui/lib/locale/lang/id'
import eleLocaleJa from 'element-ui/lib/locale/lang/ja'
import eleLocaleKo from 'element-ui/lib/locale/lang/ko'
import eleLocalePtBR from 'element-ui/lib/locale/lang/pt-br'
import eleLocaleRu from 'element-ui/lib/locale/lang/ru-RU'
import eleLocaleTr from 'element-ui/lib/locale/lang/tr-TR'
import eleLocaleZhCN from 'element-ui/lib/locale/lang/zh-CN'
import eleLocaleZhTW from 'element-ui/lib/locale/lang/zh-TW'
import eleLocaleUk from 'element-ui/lib/locale/lang/ua'
import appLocaleCa from '@shared/locales/ca'
import appLocaleDe from '@shared/locales/de'
import appLocaleEnUS from '@shared/locales/en-US'
import appLocaleEs from '@shared/locales/es'
import appLocaleFa from '@shared/locales/fa'
import appLocaleFr from '@shared/locales/fr'
import appLocaleId from '@shared/locales/id'
import appLocaleJa from '@shared/locales/ja'
import appLocaleKo from '@shared/locales/ko'
import appLocalePtBR from '@shared/locales/pt-BR'
import appLocaleRu from '@shared/locales/ru'
import appLocaleTr from '@shared/locales/tr'
import appLocaleZhCN from '@shared/locales/zh-CN'
import appLocaleZhTW from '@shared/locales/zh-TW'
import appLocaleUk from '@shared/locales/uk'

// Please keep the locale key in alphabetical order.
/* eslint-disable quote-props */
const resources = {
  'ca': {
    translation: {
      ...eleLocaleCa,
      ...appLocaleCa
    }
  },
  'de': {
    translation: {
      ...eleLocaleDe,
      ...appLocaleDe
    }
  },
  'en-US': {
    translation: {
      ...eleLocaleEn,
      ...appLocaleEnUS
    }
  },
  'es': {
    translation: {
      ...eleLocaleEs,
      ...appLocaleEs
    }
  },
  'fa': {
    translation: {
      ...eleLocaleFa,
      ...appLocaleFa
    }
  },
  'fr': {
    translation: {
      ...eleLocaleFr,
      ...appLocaleFr
    }
  },
  'id': {
    translation: {
      ...eleLocaleId,
      ...appLocaleId
    }
  },
  'ja': {
    translation: {
      ...eleLocaleJa,
      ...appLocaleJa
    }
  },
  'ko': {
    translation: {
      ...eleLocaleKo,
      ...appLocaleKo
    }
  },
  'pt-BR': {
    translation: {
      ...eleLocalePtBR,
      ...appLocalePtBR
    }
  },
  'ru': {
    translation: {
      ...eleLocaleRu,
      ...appLocaleRu
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
  'uk': {
    translation: {
      ...eleLocaleUk,
      ...appLocaleUk
    }
  }
}
/* eslint-enable quote-props */

export default resources
