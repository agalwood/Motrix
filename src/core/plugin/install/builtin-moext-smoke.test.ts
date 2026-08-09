import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractMoext } from './moext-reader'

const ROOT = path.resolve(__dirname, '../../../..')
// Mirrors retained by scripts/fetch-builtins.mjs next to the unpacked seeds.
const MOEXT_DIR = path.join(ROOT, 'dist/builtin-moext')

const lock = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts/builtins.lock.json'), 'utf8')
) as { plugins: Record<string, { version: string; file: string }> }

describe('builtin .moext files extract via PluginInstaller path', () => {
  for (const [id, entry] of Object.entries(lock.plugins)) {
    it(`${entry.file} unpacks with manifest + dist/plugin.js`, async () => {
      const dest = mkdtempSync(path.join(os.tmpdir(), 'moext-smoke-'))
      try {
        const r = await extractMoext(path.join(MOEXT_DIR, entry.file), dest)
        const manifest = JSON.parse(r.manifestRaw)
        expect(manifest.id).toBe(id)
        expect(manifest.version).toBe(entry.version)
        expect(r.bundleSha256).toMatch(/^[a-f0-9]{64}$/)
        expect(r.totalUncompressed).toBeGreaterThan(0)
      } finally {
        rmSync(dest, { recursive: true, force: true })
      }
    })
  }
})
