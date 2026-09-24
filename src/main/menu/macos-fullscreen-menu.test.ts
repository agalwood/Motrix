import { describe, expect, it, vi } from 'vitest'
import {
  MACOS_AUTOMATIC_FULLSCREEN_MENU_ITEM_KEY,
  suppressMacOSAutomaticFullscreenMenuItem,
} from './macos-fullscreen-menu'

describe('suppressMacOSAutomaticFullscreenMenuItem', () => {
  it('disables the AppKit-injected full-screen row on macOS', () => {
    const setUserDefault = vi.fn()

    suppressMacOSAutomaticFullscreenMenuItem('darwin', { setUserDefault })

    expect(setUserDefault).toHaveBeenCalledOnce()
    expect(setUserDefault).toHaveBeenCalledWith(
      MACOS_AUTOMATIC_FULLSCREEN_MENU_ITEM_KEY,
      'boolean',
      false
    )
  })

  it.each(['win32', 'linux'] as const)(
    'does not write macOS defaults on %s',
    (platform) => {
      const setUserDefault = vi.fn()

      suppressMacOSAutomaticFullscreenMenuItem(platform, { setUserDefault })

      expect(setUserDefault).not.toHaveBeenCalled()
    }
  )
})
