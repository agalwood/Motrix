import { RunMode } from '@shared/constants'
import { describe, expect, it } from 'vitest'
import { resolveMainWindowStartupPlan } from './window-startup-plan'

describe('resolveMainWindowStartupPlan', () => {
  it.each([RunMode.Standard, RunMode.HideTray])(
    'creates and shows an interactive %s launch',
    (runMode) => {
      expect(
        resolveMainWindowStartupPlan({
          openedAtLogin: false,
          runMode,
          releaseWhenHidden: true,
        })
      ).toEqual({ create: true, show: true })
    }
  )

  it('keeps a background renderer in the default retention mode', () => {
    expect(
      resolveMainWindowStartupPlan({
        openedAtLogin: true,
        runMode: RunMode.Standard,
        releaseWhenHidden: false,
      })
    ).toEqual({ create: true, show: false })
  })

  it.each([RunMode.Standard, RunMode.TrayOnly, RunMode.HideTray])(
    'skips a hidden %s renderer when release is enabled',
    (runMode) => {
      expect(
        resolveMainWindowStartupPlan({
          openedAtLogin: true,
          runMode,
          releaseWhenHidden: true,
        })
      ).toEqual({ create: false, show: false })
    }
  )

  it('treats tray-only as a background launch without login metadata', () => {
    expect(
      resolveMainWindowStartupPlan({
        openedAtLogin: false,
        runMode: RunMode.TrayOnly,
        releaseWhenHidden: true,
      })
    ).toEqual({ create: false, show: false })
  })
})
