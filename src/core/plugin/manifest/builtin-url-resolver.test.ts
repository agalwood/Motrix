import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseManifest } from '@core/plugin/manifest/parse'
import { describe, expect, it } from 'vitest'

describe('motrix.url-resolver manifest', () => {
  it('parses with origin=builtin', async () => {
    const raw = await readFile(
      path.join(
        process.cwd(),
        'dist/builtin-plugins/motrix.url-resolver/motrix-plugin.json'
      ),
      'utf8'
    )
    const r = parseManifest(raw, { hostVersion: '2.5.0', origin: 'builtin' })
    expect(r.manifest.id).toBe('motrix.url-resolver')
    expect(r.warnings).toEqual([])
  })
  it('parseManifest rejects same id under origin=community', async () => {
    const raw = await readFile(
      path.join(
        process.cwd(),
        'dist/builtin-plugins/motrix.url-resolver/motrix-plugin.json'
      ),
      'utf8'
    )
    expect(() =>
      parseManifest(raw, { hostVersion: '2.5.0', origin: 'community' })
    ).toThrow(/reserved/i)
  })
})
