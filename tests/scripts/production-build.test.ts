import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const MIB = 1024 * 1024
const ROOT = path.resolve(import.meta.dirname, '../..')
const TARGETS = [
  // Keep the 2 MiB startup ceiling and bound the complete lazy-loaded output.
  // Source editing, replay persistence and translations measure 5,843,106 bytes.
  // Add 32 KiB to the total budget; keep startup at 2 MiB.
  { name: 'main', initial: 2 * MIB, total: 5.5 * MIB + 84 * 1024 },
  { name: 'preload', initial: 80 * 1024, total: 80 * 1024 },
  { name: 'worker', initial: 48 * 1024, total: 48 * 1024 },
  // Native NAS strings in all 26 catalogs add ~60 KiB; the Web-only settings
  // dialog stays lazy and is excluded from Electron. Startup ceilings are unchanged.
  // React Flow 13's compiled call graph adds ~65 KiB (~26 KiB gzip), entirely
  // in lazy chunks. Reserve a further 64 KiB; retain the startup ceiling.
  // Source editing measures 8,521,681 / 8,567,340 bytes (desktop / web).
  // Add 16 KiB per total budget; retain both startup ceilings.
  { name: 'renderer', initial: 2.75 * MIB, total: 8 * MIB + 144 * 1024 },
  // The lazy DSM storage recovery page and its localized controls add 9 KiB.
  { name: 'renderer.web', initial: 2.75 * MIB, total: 8 * MIB + 188 * 1024 },
  // The shared operation runtime brings total server JS to ~5.01 MiB.
  { name: 'server', initial: 2 * MIB, total: 5.25 * MIB },
]

interface BundleMetrics {
  copiesPublicAssets: boolean
  totalBytes: number
  initialBytes: number
  initialChunks: number
  sourceMaps: number
  initialLocales: string[]
  bundledLocales: string[]
  bundledOperatorAdmin: boolean
  initialElk: boolean
  bundledElk: boolean
  javascriptAssetBytes: number
  javascriptAssetCount: number
}

let report: Record<string, BundleMetrics>
beforeAll(() => {
  // Vite respects an inherited NODE_ENV=test even in production mode. Build in
  // a separate process so these assertions exercise shipped React, not dev React.
  report = JSON.parse(
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts/measure-production-bundles.mjs')],
      {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: 'production' },
        encoding: 'utf8',
        maxBuffer: MIB,
        timeout: 60_000,
      }
    )
  )
}, 65_000)

describe('production bundle loading and size contracts', () => {
  it.each(TARGETS)(
    '$name keeps deferred resources out of startup and fits its JS budgets',
    (target) => {
      const result = report[target.name]
      expect(result.copiesPublicAssets).toBe(target.name.startsWith('renderer'))
      expect(result.initialChunks).toBeGreaterThan(0)
      expect(result.initialBytes).toBeLessThanOrEqual(target.initial)
      expect(result.totalBytes).toBeLessThanOrEqual(target.total)
      expect(result.sourceMaps).toBe(0)
      if (target.name === 'main')
        expect(result.bundledOperatorAdmin).toBe(false)
      if (
        ['main', 'server', 'renderer', 'renderer.web'].includes(target.name)
      ) {
        expect(result.initialLocales).toEqual(['en-US', 'zh-CN'])
        expect(result.bundledLocales).toHaveLength(26)
      }
      if (target.name.startsWith('renderer')) {
        expect(result.initialElk).toBe(false)
        expect(result.bundledElk).toBe(true)
        expect(result.javascriptAssetCount).toBe(1)
        expect(result.javascriptAssetBytes).toBeGreaterThan(MIB)
        expect(result.totalBytes).toBeGreaterThan(
          result.initialBytes + result.javascriptAssetBytes
        )
      }
    }
  )
})
