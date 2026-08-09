import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { JsonSchemaNode } from '@shared/types/plugin'
import { describe, expect, it } from 'vitest'
import { type ManifestLocaleDict, resolveManifestI18n } from './i18n-resolve'
import { parseManifest } from './parse'

// Each builtin ships a config schema whose field titles MUST localize through
// the manifest %placeholder% mechanism. Without a resolvable title the renderer
// (PluginSettingsForm) falls back to a non-existent app i18next key and shows a
// raw string like "plugin.motrix.scraper-hook.settings.enabled.title".
const BUILTINS = [
  'motrix.scraper-hook',
  'motrix.filename-template',
  'motrix.url-resolver',
] as const

const PLACEHOLDER_RE = /%[\w.-]+%/

async function loadDict(pluginDir: string): Promise<ManifestLocaleDict> {
  const raw = await readFile(
    path.join(pluginDir, 'locales', 'en-US.json'),
    'utf8'
  )
  const parsed = JSON.parse(raw)
  const out: ManifestLocaleDict = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

describe('builtin plugin config field localization', () => {
  for (const id of BUILTINS) {
    it(`${id}: every config field has a resolvable title`, async () => {
      const dir = path.join(process.cwd(), 'dist', 'builtin-plugins', id)
      const raw = await readFile(path.join(dir, 'motrix-plugin.json'), 'utf8')
      const dict = await loadDict(dir)
      const { manifest } = parseManifest(raw, {
        hostVersion: '2.5.0',
        origin: 'builtin',
      })
      const resolved = resolveManifestI18n(manifest, {
        currentDict: dict,
        fallbackDict: dict,
      })

      const schema = resolved.contributes.configuration?.schema as
        | JsonSchemaNode
        | undefined
      const props = schema?.properties ?? {}
      expect(Object.keys(props).length).toBeGreaterThan(0)

      for (const [field, node] of Object.entries(props)) {
        // A localized title must exist and must not be a literal %key%
        // left behind by a missing locale entry.
        expect(node.title, `${id}.${field} title`).toBeTruthy()
        expect(
          PLACEHOLDER_RE.test(node.title ?? ''),
          `${id}.${field} title still a placeholder`
        ).toBe(false)
      }
    })
  }
})
