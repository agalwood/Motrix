import { RunMode } from '@shared/constants'
import { describe, expect, it } from 'vitest'
import { resolveDesktopBackgroundPolicy } from './desktop-background-policy'

describe('resolveDesktopBackgroundPolicy', () => {
  it.each<NodeJS.Platform>(['win32', 'linux'])(
    'forces a tray and releases the renderer for lightweight HideTray on %s',
    (platform) => {
      expect(
        resolveDesktopBackgroundPolicy({
          lightweightMode: true,
          platform,
          runMode: RunMode.HideTray,
        })
      ).toEqual({
        keepTray: true,
        releaseMainWindowWhenHidden: true,
      })
    }
  )

  it('uses the Dock instead of forcing a tray for lightweight HideTray on macOS', () => {
    expect(
      resolveDesktopBackgroundPolicy({
        lightweightMode: true,
        platform: 'darwin',
        runMode: RunMode.HideTray,
      })
    ).toEqual({
      keepTray: false,
      releaseMainWindowWhenHidden: true,
    })
  })

  it.each([RunMode.Standard, RunMode.TrayOnly])(
    'preserves the tray in run mode %s',
    (runMode) => {
      expect(
        resolveDesktopBackgroundPolicy({
          lightweightMode: false,
          platform: 'linux',
          runMode,
        })
      ).toEqual({
        keepTray: true,
        releaseMainWindowWhenHidden: false,
      })
    }
  )

  it.each<NodeJS.Platform>(['win32', 'linux'])(
    'keeps a reopen surface for unsupported HideTray on %s',
    (platform) => {
      expect(
        resolveDesktopBackgroundPolicy({
          lightweightMode: false,
          platform,
          runMode: RunMode.HideTray,
        })
      ).toEqual({
        keepTray: true,
        releaseMainWindowWhenHidden: false,
      })
    }
  )
})
