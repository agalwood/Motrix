import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyBuiltinSignature } from '../update/signature'
import { extractMoext } from './moext-reader'

const ROOT = path.resolve(__dirname, '../../../..')
// Mirrors retained by scripts/fetch-builtins.mjs next to the unpacked seeds.
const MOEXT_DIR = path.join(ROOT, 'dist/builtin-moext')

const lock = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts/builtins.lock.json'), 'utf8')
) as {
  plugins: Record<
    string,
    { version: string; file: string; sha256: string; size: number }
  >
}

function exactArtifactPath(file: string): string {
  const sourceDir = process.env.MOTRIX_BUILTIN_ARTIFACT_DIR
  return path.join(sourceDir ?? MOEXT_DIR, file)
}

function exactSignaturePath(entry: { file: string; sha256: string }): string {
  const sourceDir = process.env.MOTRIX_BUILTIN_ARTIFACT_DIR
  if (sourceDir) return path.join(sourceDir, `${entry.file}.sig`)
  return path.join(
    ROOT,
    'node_modules/.cache/motrix-builtins',
    `${entry.sha256}.moext.sig`
  )
}

describe('builtin .moext files extract via PluginInstaller path', () => {
  for (const [id, entry] of Object.entries(lock.plugins)) {
    it(`${entry.file} is the exact lock-pinned, Ed25519-signed release artifact`, () => {
      const artifactPath = exactArtifactPath(entry.file)
      const signaturePath = exactSignaturePath(entry)
      expect(existsSync(artifactPath), artifactPath).toBe(true)
      expect(existsSync(signaturePath), signaturePath).toBe(true)

      const bytes = readFileSync(artifactPath)
      const signature = readFileSync(signaturePath, 'utf8').trim()
      expect(bytes.byteLength).toBe(entry.size)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        entry.sha256
      )
      expect(verifyBuiltinSignature(bytes, signature)).toBe(true)
    })

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
