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

describe('syncAutoLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('enables login item with --opened-at-login arg', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    syncAutoLaunch(true)

    expect(mockSetLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: ['--opened-at-login=1'],
    })

    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('disables login item with empty args', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    syncAutoLaunch(false)

    expect(mockSetLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      args: [],
    })

    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('skips on linux', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })

    syncAutoLaunch(true)

    expect(mockSetLoginItemSettings).not.toHaveBeenCalled()

    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })
})
