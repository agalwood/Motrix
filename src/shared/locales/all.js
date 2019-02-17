import eleLocaleEn from 'element-ui/lib/locale/lang/en'
import eleLocaleZhCN from 'element-ui/lib/locale/lang/zh-CN'
import eleLocaleTr from 'element-ui/lib/locale/lang/tr-TR'
import appLocaleEnUS from '@shared/locales/en-US'
import appLocaleZhCN from '@shared/locales/zh-CN'
import appLocaleTr from '@shared/locales/tr'

const resources = {
  'en-US': {
    translation: {
      ...eleLocaleEn,
      ...appLocaleEnUS
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
  }
}

export default resources
