import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSetLoginItemSettings } = vi.hoisted(() => ({
  mockSetLoginItemSettings: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    setLoginItemSettings: mockSetLoginItemSettings,
    isPackaged: true,
  },
}))

import { syncAutoLaunch } from './auto-launch'
import { setPortableProfile } from './portable-profile'

describe('syncAutoLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['darwin', 'win32'])(
    'enables %s login item with --opened-at-login arg',
    (platform) => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: platform })

      syncAutoLaunch(true)

      expect(mockSetLoginItemSettings).toHaveBeenCalledWith({
        openAtLogin: true,
        args: ['--opened-at-login=1'],
      })

      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  )

  it.each(['darwin', 'win32'])(
    'disables %s login item with empty args',
    (platform) => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: platform })

      syncAutoLaunch(false)

      expect(mockSetLoginItemSettings).toHaveBeenCalledWith({
        openAtLogin: false,
        args: [],
      })

      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  )

  it('skips on linux', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })

    syncAutoLaunch(true)

    expect(mockSetLoginItemSettings).not.toHaveBeenCalled()

    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })
})

it('never adds or removes host startup entries from a portable profile', () => {
  mockSetLoginItemSettings.mockClear()
  setPortableProfile({
    root: 'E:\\Motrix',
    dataDir: '',
    userDataDir: '',
    tempDir: '',
    workDir: '',
    downloadsDir: '',
  })
  try {
    syncAutoLaunch(true)
    syncAutoLaunch(false)
    expect(mockSetLoginItemSettings).not.toHaveBeenCalled()
  } finally {
    setPortableProfile(null)
  }
})
