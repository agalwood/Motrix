import type { Plugin } from 'vite'

/** Keep Server-only and renderer-only catalogs out of the desktop main bundle. */
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
      const settings = catalog.settings as Record<string, unknown> | undefined
      const integration = settings?.integration as
        | Record<string, unknown>
        | undefined
      // Extension settings and pairing prompts are rendered by the shared UI.
      // Native integration prompts and media errors still need their catalogs.
      if (integration) delete integration.browser
      const task = catalog.task as Record<string, unknown> | undefined
      const add = task?.add as Record<string, unknown> | undefined
      if (add) delete add.duplicate
      const storage = task?.storage as Record<string, unknown> | undefined
      if (task && storage) {
        // Dialogs load their full catalog in the renderer. Keep every key
        // emitted as a host-side error or persisted task diagnostic.
        task.storage = {
          incomplete: storage.incomplete,
          resumeFailed: storage.resumeFailed,
          errors: storage.errors,
        }
      }
      return { code: JSON.stringify(catalog), map: null }
    },
  }
}
