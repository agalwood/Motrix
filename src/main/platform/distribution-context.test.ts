import { describe, expect, it, vi } from 'vitest'
import { resolveDistributionContext } from './distribution-context'

describe('resolveDistributionContext', () => {
  it('classifies a packaged Windows app without claiming Store provenance', () => {
    expect(
      resolveDistributionContext({
        platform: 'win32',
        isPackaged: true,
        windowsStore: true,
      })
    ).toEqual({ distribution: 'windows-package', isWindowsPackage: true })
  })

  it.each([true, false, undefined])(
    'keeps an unpackaged Windows app in development when windowsStore is %s',
    (windowsStore) => {
      expect(
        resolveDistributionContext({
          platform: 'win32',
          isPackaged: false,
          windowsStore,
        })
      ).toEqual({ distribution: 'development', isWindowsPackage: false })
    }
  )

  it.each([false, undefined])(
    'preserves direct Windows installations when windowsStore is %s',
    (windowsStore) => {
      expect(
        resolveDistributionContext({
          platform: 'win32',
          isPackaged: true,
          windowsStore,
        })
      ).toEqual({ distribution: 'direct', isWindowsPackage: false })
    }
  )

  it.each(['darwin', 'linux'] as const)(
    'does not classify %s as a Windows package even when the flag is set',
    (platform) => {
      expect(
        resolveDistributionContext({
          platform,
          isPackaged: true,
          windowsStore: true,
        })
      ).toEqual({ distribution: 'direct', isWindowsPackage: false })
    }
  )

  it('does not treat an environment variable as a package identity signal', () => {
    vi.stubEnv('MOTRIX_DISTRIBUTION', 'microsoft-store')
    try {
      expect(
        resolveDistributionContext({ platform: 'win32', isPackaged: true })
      ).toEqual({ distribution: 'direct', isWindowsPackage: false })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
