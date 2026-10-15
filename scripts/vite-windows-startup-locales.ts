import path from 'node:path'
import { normalizePath, type Plugin } from 'vite'

export const WINDOWS_STARTUP_LOCALE_KEYS = [
  'startupLoading',
  'startupUnavailable',
  'startupNotApplied',
  'startupStateUnavailable',
  'startupUnsupported',
  'startupDisabled',
  'startupDisabledByUser',
  'startupEnabled',
  'startupDisabledByPolicy',
  'startupEnabledByPolicy',
  'startupOpenSettings',
  'startupOpenSettingsFailed',
] as const

/** Web and Server cannot perform Windows startup operations or show their UI. */
export function omitWindowsStartupLocales(
  localeDirectory = path.resolve(import.meta.dirname, '../src/shared/locales')
): Plugin {
  const directory = `${normalizePath(localeDirectory)}/`
  return {
    name: 'motrix-omit-windows-startup-locales',
    enforce: 'pre',
    transform(source, id) {
      const file = normalizePath(id.split('?')[0])
      if (!file.startsWith(directory)) return null
      const name = file.slice(directory.length)
      if (!/^[\w-]+\.json$/.test(name)) return null
      const catalog = JSON.parse(source)
      const general = catalog.settings?.general
      if (!general || typeof general !== 'object' || Array.isArray(general))
        throw new Error('Invalid settings translation catalog')
      for (const key of WINDOWS_STARTUP_LOCALE_KEYS) delete general[key]
      return { code: JSON.stringify(catalog), map: null }
    },
  }
}
