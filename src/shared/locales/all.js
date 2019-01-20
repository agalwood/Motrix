import eleLocaleEn from 'element-ui/lib/locale/lang/en'
import eleLocaleZhCN from 'element-ui/lib/locale/lang/zh-CN'
import appLocaleEnUS from '@shared/locales/en-US'
import appLocaleZhCN from '@shared/locales/zh-CN'

const resources = {
  'en-US': {
    translation: {
      ...eleLocaleEn,
      ...appLocaleEnUS
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
