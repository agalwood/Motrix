// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import {
  omitWindowsStartupLocales,
  WINDOWS_STARTUP_LOCALE_KEYS,
} from '../../scripts/vite-windows-startup-locales'

const locales = path.resolve('src/shared/locales')

describe('Windows-only startup translations in production builds', () => {
  it('preserves every other value and the desktop source in all 26 catalogs', async () => {
    const plugin = omitWindowsStartupLocales()
    const transform = plugin.transform as (
      source: string,
      id: string
    ) => { code: string } | null
    const files = (await readdir(locales)).filter((file) =>
      file.endsWith('.json')
    )
    expect(files).toHaveLength(26)
    for (const file of files) {
      const source = await readFile(path.join(locales, file), 'utf8')
      const original = JSON.parse(source)
      const filtered = JSON.parse(
        transform(source, path.join(locales, file))!.code
      )
      for (const key of WINDOWS_STARTUP_LOCALE_KEYS) {
        expect(typeof original.settings.general[key]).toBe('string')
        expect(filtered.settings.general).not.toHaveProperty(key)
        filtered.settings.general[key] = original.settings.general[key]
      }
      expect(filtered).toEqual(original)
      expect(await readFile(path.join(locales, file), 'utf8')).toBe(source)
    }
    for (const id of [
      'src/other.json',
      `${locales}/nested/en-US.json`,
      `${locales}-other/en-US.json`,
    ])
      expect(transform('not JSON', id)).toBeNull()
  })

  it.each([false, true])(
    'filters before Vite JSON compilation with SSR=%s',
    async (ssr) => {
      const root = await mkdtemp(path.join(tmpdir(), 'motrix-startup-locales-'))
      try {
        const entry = path.join(root, 'entry.mjs')
        const file = path.join(locales, 'en-US.json')
        await writeFile(
          entry,
          `import catalog from ${JSON.stringify(file)}; export default catalog;`
        )
        for (const filtered of [false, true]) {
          const outDir = path.join(root, filtered ? 'web-server' : 'desktop')
          await build({
            configFile: false,
            logLevel: 'silent',
            plugins: filtered ? [omitWindowsStartupLocales()] : [],
            build: {
              ssr,
              outDir,
              minify: false,
              rollupOptions: { output: { entryFileNames: 'catalog.mjs' } },
              lib: { entry, formats: ['es'], fileName: () => 'catalog.mjs' },
            },
          })
          const { default: catalog } = await import(
            pathToFileURL(path.join(outDir, 'catalog.mjs')).href
          )
          expect(catalog.settings.general.launchAtStartup).toBe('Open at login')
          expect(catalog.settings.general.startupAndQuitting).toBe(
            'Startup and quitting'
          )
          expect(
            Object.hasOwn(catalog.settings.general, 'startupDisabledByUser')
          ).toBe(!filtered)
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
