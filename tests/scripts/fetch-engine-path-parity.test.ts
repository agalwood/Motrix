import path from 'node:path'
import { aria2BinaryName } from '@shared/platform/aria2'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — .mjs without types
import { bundledPath } from '../../scripts/fetch-engine.mjs'

// Anti-drift guard for rev-2 §3.1: fetch-engine.mjs owns an INLINE copy of the
// path logic (it must run under bare Node, so it cannot import @shared at
// runtime). This test runs under Vitest — where the alias + TS ARE available —
// and asserts the inline copy stays identical to the host-owned layout plus
// the shared binary-name rule.
const MATRIX: Array<[NodeJS.Platform, string]> = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['win32', 'x64'],
  ['win32', 'ia32'],
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['linux', 'arm'],
]

describe('fetch-engine inline bundledPath parity with host layout', () => {
  const extra = path.join('/repo', 'extra')
  for (const [platform, arch] of MATRIX) {
    it(`matches the host layout for ${platform}/${arch}`, () => {
      expect(bundledPath(extra, platform, arch)).toBe(
        path.join(extra, platform, arch, aria2BinaryName(platform))
      )
    })
  }
})
