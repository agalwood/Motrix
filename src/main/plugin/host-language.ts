import {
  resolveSupportedLocale,
  type SupportedLocale,
} from '@shared/constants/locales'
import { app } from 'electron'

/** Resolve persisted/system candidates through the shared locale catalog. */
export function resolvePluginHostLanguage(
  settingsLanguage: string
): SupportedLocale {
  return resolveSupportedLocale(settingsLanguage, app.getLocale())
}
