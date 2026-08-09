import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  SUPPORTED_LOCALE_CODES,
} from '@shared/constants/locales'
import { I18N_RESOURCES } from '@shared/i18n-resources'
import i18n from 'i18next'

i18n.init({
  resources: I18N_RESOURCES,
  supportedLngs: SUPPORTED_LOCALE_CODES,
  lng: DEFAULT_LOCALE,
  fallbackLng: FALLBACK_LOCALE,
  interpolation: {
    escapeValue: false,
  },
})

export { i18n }
