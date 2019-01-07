import elementEnLocale from 'element-ui/lib/locale/lang/en'
import elementZhLocale from 'element-ui/lib/locale/lang/zh-CN'
import enLocale from '@shared/locales/en'
import zhLocale from '@shared/locales/zh'

const resources = {
  'en': {
    translation: {
      ...elementEnLocale,
      ...enLocale
    }
  },
  'zh': {
    translation: {
      ...elementZhLocale,
      ...zhLocale
    }
  }
}

export default resources
