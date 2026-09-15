import type { SettingsManager } from '@core/settings/settings-manager'
import { RunMode } from '@shared/constants'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appDock } = vi.hoisted(() => ({
  appDock: { hide: vi.fn() },
}))

vi.mock('electron', () => {
  class MockBrowserWindow {
    webContents = {
      send: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    }
    private destroyed = false
    private visible = false

    show = vi.fn(() => {
      this.visible = true
    })
    showInactive = vi.fn(() => {
      this.visible = true
    })
    hide = vi.fn(() => {
      this.visible = false
    })
    focus = vi.fn()
    destroy = vi.fn(() => {
      this.destroyed = true
    })
    isDestroyed = vi.fn(() => this.destroyed)
    isVisible = vi.fn(() => this.visible)
    isFocused = vi.fn(() => true)
    isMaximized = vi.fn(() => false)
    isFullScreen = vi.fn(() => false)
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 1024, height: 768 }))
    getNormalBounds = vi.fn(() => ({
      x: 0,
      y: 0,
      width: 1024,
      height: 768,
    }))
    maximize = vi.fn()
    setBounds = vi.fn()
    setMinimumSize = vi.fn()
    setAutoHideMenuBar = vi.fn()
    setMenuBarVisibility = vi.fn()
    setWindowButtonVisibility = vi.fn()
    center = vi.fn()
    removeAllListeners = vi.fn()
    on = vi.fn().mockReturnThis()
    once = vi.fn().mockReturnThis()
  }

  return {
    app: { dock: appDock },
    BrowserWindow: MockBrowserWindow,
    nativeTheme: { shouldUseDarkColors: false },
    screen: { getAllDisplays: vi.fn(() => []) },
    shell: { openExternal: vi.fn() },
  }
})

import { createRendererUrlPolicy } from './renderer-url-policy'
import { WindowManager } from './window-manager'

function createSettingsManager(runMode: RunMode): SettingsManager {
  return {
    get: vi.fn(() => ({ app: { runMode }, windowState: {} })),
    update: vi.fn().mockResolvedValue({ saved: true }),
  } as unknown as SettingsManager
}

function createWindowManager(runMode: RunMode): WindowManager {
  return new WindowManager({
    settingsManager: createSettingsManager(runMode),
    preloadPath: '/fake/preload.cjs',
    loadUrl: vi.fn(),
    platform: 'darwin',
    rendererUrlPolicy: createRendererUrlPolicy({
      isPackaged: true,
      appPath: '/app',
    }),
  })
}

describe('WindowManager macOS Dock visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('re-hides the Dock when a Menu Bar Only main window is dismissed', () => {
    const wm = createWindowManager(RunMode.TrayOnly)
    const win = wm.open('main')
    const closeListener = (
      win.on as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.find(([event]) => event === 'close')?.[1] as
      | ((event: { preventDefault(): void }) => void)
      | undefined
    const closeEvent = { preventDefault: vi.fn() }

    closeListener?.(closeEvent)

    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(win.hide).toHaveBeenCalledOnce()
    expect(appDock.hide).toHaveBeenCalledOnce()
  })

  it('does not hide the Dock when the run mode is Standard', () => {
    const wm = createWindowManager(RunMode.Standard)
    const win = wm.open('main')
    const closeListener = (
      win.on as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.find(([event]) => event === 'close')?.[1] as
      | ((event: { preventDefault(): void }) => void)
      | undefined

    closeListener?.({ preventDefault: vi.fn() })

    expect(win.hide).toHaveBeenCalledOnce()
    expect(appDock.hide).not.toHaveBeenCalled()
  })
})
