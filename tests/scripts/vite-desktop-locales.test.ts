import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { desktopLocaleProjection } from '../../scripts/vite-desktop-locales'

describe('desktop main locale projection', () => {
  const root = path.resolve(import.meta.dirname, '../../src/shared/locales')
  const plugin = desktopLocaleProjection(root)
  const transform = plugin.transform as (
    source: string,
    id: string
  ) => { code: string } | null

  it('omits non-main UI catalogs while preserving host errors in every locale', () => {
    for (const file of readdirSync(root).filter((name) =>
      name.endsWith('.json')
    )) {
      const source = readFileSync(path.join(root, file), 'utf8')
      const original = JSON.parse(source)
      expect(original.operatorAdmin).toBeDefined()
      const result = JSON.parse(transform(source, path.join(root, file))!.code)
      expect(result.operatorAdmin).toBeUndefined()
      expect(result.settings.integration.browser).toBeUndefined()
      expect(result.task.add.duplicate).toBeUndefined()
      expect(result.task.storage).toEqual({
        incomplete: original.task.storage.incomplete,
        resumeFailed: original.task.storage.resumeFailed,
        errors: original.task.storage.errors,
      })
      delete original.operatorAdmin
      delete original.settings.integration.browser
      delete original.task.add.duplicate
      original.task.storage = {
        incomplete: original.task.storage.incomplete,
        resumeFailed: original.task.storage.resumeFailed,
        errors: original.task.storage.errors,
      }
      expect(result).toEqual(original)
      // The source catalogs, consumed by renderer and Server, stay complete.
      expect(
        JSON.parse(source).settings.integration.browser.profile
      ).toBeDefined()
      expect(
        JSON.parse(source).settings.integration.browser.pairToast
      ).toBeDefined()
      expect(JSON.parse(source).task.storage.move).toBeDefined()
      expect(JSON.parse(source).task.add.duplicate).toBeDefined()
    }
  })

  it('leaves unrelated JSON and scripts unchanged', () => {
    expect(transform('{}', path.join(root, '../schemas/test.json'))).toBeNull()
    expect(
      transform('export default {}', path.join(root, 'test.ts'))
    ).toBeNull()
  })

  it('recognizes Windows module paths with Vite query suffixes', () => {
    const windowsPlugin = desktopLocaleProjection(
      'C:\\app\\src\\shared\\locales'
    )
    const windowsTransform = windowsPlugin.transform as typeof transform
    expect(
      JSON.parse(
        windowsTransform(
          '{"operatorAdmin":{},"settings":{"x":"y"}}',
          'C:\\app\\src\\shared\\locales\\en-US.json?import'
        )!.code
      )
    ).toEqual({ settings: { x: 'y' } })
  })
})
