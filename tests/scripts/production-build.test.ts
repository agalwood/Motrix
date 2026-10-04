import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const MIB = 1024 * 1024
const ROOT = path.resolve(import.meta.dirname, '../..')
const TARGETS = [
  { name: 'main', initial: 2 * MIB, total: 5 * MIB },
  { name: 'preload', initial: 80 * 1024, total: 80 * 1024 },
  { name: 'worker', initial: 48 * 1024, total: 48 * 1024 },
  { name: 'renderer', initial: 2.75 * MIB, total: 8 * MIB },
  { name: 'renderer.web', initial: 2.75 * MIB, total: 8 * MIB },
  { name: 'server', initial: 2 * MIB, total: 5 * MIB },
]

interface BundleMetrics {
  copiesPublicAssets: boolean
  totalBytes: number
  initialBytes: number
  initialChunks: number
  sourceMaps: number
  initialLocales: string[]
  bundledLocales: string[]
  initialElk: boolean
  bundledElk: boolean
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
      if (
        ['main', 'server', 'renderer', 'renderer.web'].includes(target.name)
      ) {
        expect(result.initialLocales).toEqual(['en-US', 'zh-CN'])
        expect(result.bundledLocales).toHaveLength(26)
      }
      if (target.name.startsWith('renderer')) {
        expect(result.initialElk).toBe(false)
        expect(result.bundledElk).toBe(true)
      }
    }
  )
})
