import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveFinalizeSidecarPath } from './sidecar-path'

describe('resolveFinalizeSidecarPath', () => {
  it('uses an explicit absolute override first', () => {
    expect(
      resolveFinalizeSidecarPath({
        extraResourceDir: '/app/extra',
        isDev: false,
        env: { MOTRIX_FINALIZE_FS_BIN: '/custom/motrix-finalize-fs' },
      })
    ).toBe('/custom/motrix-finalize-fs')
  })

  it('rejects a relative override', () => {
    expect(() =>
      resolveFinalizeSidecarPath({
        extraResourceDir: '/app/extra',
        isDev: false,
        env: { MOTRIX_FINALIZE_FS_BIN: 'relative/finalize-fs' },
      })
    ).toThrow('must be an absolute path')
  })

  it('resolves the Electron development target', () => {
    expect(
      resolveFinalizeSidecarPath({
        extraResourceDir: '/repo/extra',
        isDev: true,
        env: {},
        platform: 'darwin',
        arch: 'arm64',
      })
    ).toBe(
      path.resolve(
        '/repo/packages/finalize-fs/dist/darwin-arm64/motrix-finalize-fs'
      )
    )
  })

  it('uses the staged Server binary when it exists', () => {
    expect(
      resolveFinalizeSidecarPath({
        extraResourceDir: '/stage/extra',
        isDev: false,
        env: {},
        platform: 'linux',
        arch: 'x64',
        runtimeRoot: '/stage',
        fileExists: (candidate) =>
          candidate === '/stage/bin/motrix-finalize-fs',
      })
    ).toBe('/stage/bin/motrix-finalize-fs')
  })

  it('uses the locally built Server binary from a normal checkout', () => {
    const local = '/repo/packages/finalize-fs/dist/linux-x64/motrix-finalize-fs'
    expect(
      resolveFinalizeSidecarPath({
        extraResourceDir: '/usr/share/motrix/extra',
        isDev: false,
        env: {},
        platform: 'linux',
        arch: 'x64',
        runtimeRoot: '/repo',
        fileExists: (candidate) => candidate === local,
      })
    ).toBe(local)
  })

  it('keeps the packaged path when no verified local binary exists', () => {
    expect(
      resolveFinalizeSidecarPath({
        extraResourceDir: '/usr/share/motrix/extra',
        isDev: false,
        env: {},
        platform: 'linux',
        arch: 'x64',
        runtimeRoot: '/repo',
        fileExists: () => false,
      })
    ).toBe('/usr/share/motrix/bin/motrix-finalize-fs')
  })
})
