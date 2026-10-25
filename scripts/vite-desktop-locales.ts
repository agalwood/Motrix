import type { Plugin } from 'vite'

/** The operator-admin CLI is a separate Server entrypoint. Keep its catalog
 * out of the desktop main bundle while preserving all desktop translations. */
export function desktopLocaleProjection(localeDirectory: string): Plugin {
  const prefix = `${localeDirectory.replaceAll('\\', '/')}/`
  return {
    name: 'desktop-locale-projection',
    enforce: 'pre',
    transform(source, id) {
      const file = id.split('?')[0]?.replaceAll('\\', '/')
      if (!file?.startsWith(prefix) || !file.endsWith('.json')) return null
      const catalog = JSON.parse(source) as Record<string, unknown>
      delete catalog.operatorAdmin
      return { code: JSON.stringify(catalog), map: null }
    },
  }
}
