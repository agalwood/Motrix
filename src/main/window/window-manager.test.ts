import { Events } from '@shared/protocol/events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const instances: MockBrowserWindow[] = []

  class MockBrowserWindow {
    options: Record<string, unknown>
    webContents: {
      send: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
      removeAllListeners: ReturnType<typeof vi.fn>
      setWindowOpenHandler: ReturnType<typeof vi.fn>
    }
    private _destroyed = false
    private _visible: boolean
    private _bounds: { x: number; y: number; width: number; height: number }

    constructor(options: Record<string, unknown>) {
      this.options = options
      this._visible = (options.show as boolean) ?? true
      this._bounds = {
        x: 0,
        y: 0,
        width: (options.width as number) ?? 800,
        height: (options.height as number) ?? 600,
      }
      this.webContents = {
        send: vi.fn(),
        on: vi.fn(),
        removeAllListeners: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      }
      instances.push(this)
    }
    loadURL = vi.fn().mockResolvedValue(undefined)
    loadFile = vi.fn().mockResolvedValue(undefined)
    show = vi.fn(() => {
      this._visible = true
    })
    showInactive = vi.fn(() => {
      this._visible = true
    })
    hide = vi.fn(() => {
      this._visible = false
    })
    focus = vi.fn()
    close = vi.fn()
    destroy = vi.fn(() => {
      this._destroyed = true
    })
    isDestroyed = vi.fn(() => this._destroyed)
    isVisible = vi.fn(() => this._visible)
    isFocused = vi.fn(() => true)
    isMaximized = vi.fn(() => false)
    getBounds = vi.fn(() => ({ ...this._bounds }))
    getNormalBounds = vi.fn(() => ({ ...this._bounds }))
    maximize = vi.fn()
    setBounds = vi.fn(
      (b: { x: number; y: number; width: number; height: number }) => {
        this._bounds = b
      }
    )
    setMinimumSize = vi.fn()
    setAutoHideMenuBar = vi.fn()
    setMenuBarVisibility = vi.fn()
    setTitleBarOverlay = vi.fn()
    setWindowButtonVisibility = vi.fn()
    center = vi.fn()
    on = vi.fn().mockReturnThis()
    onceListeners: Record<string, ((...args: unknown[]) => void)[]> = {}
    once = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const list = this.onceListeners[event] ?? []
      list.push(listener)
      this.onceListeners[event] = list
      return this
    })
    removeAllListeners = vi.fn().mockReturnThis()

    fireReadyToShow() {
      const listeners = this.onceListeners['ready-to-show'] ?? []
      this.onceListeners['ready-to-show'] = []
      for (const fn of listeners) fn()
    }

    static instances = instances
  }

  const mockScreen = {
    getAllDisplays: vi.fn(() => [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]),
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    })),
  }

  return {
    BrowserWindow: MockBrowserWindow,
    screen: mockScreen,
    shell: { openExternal: vi.fn() },
  }
})

import type { SettingsManager } from '@core/settings/settings-manager'
import { BrowserWindow } from 'electron'
import type { LiquidGlassController } from './liquid-glass'
import { initializeRendererUrlPolicy } from './renderer-url-policy'
import { WINDOW_CONFIGS } from './window-configs'
import { WindowManager } from './window-manager'

initializeRendererUrlPolicy({
  isPackaged: true,
  appPath: '/app',
})

function createMockSettingsManager(
  windowState: Record<string, unknown> = {}
): SettingsManager {
  const settings = { windowState }
  return {
    get: vi.fn(() => settings),
    update: vi.fn().mockResolvedValue({ saved: true }),
  } as unknown as SettingsManager
}

describe('WindowManager', () => {
  beforeEach(() => {
    ;(BrowserWindow as unknown as { instances: unknown[] }).instances.length = 0
    vi.clearAllMocks()
  })

  it('opens a window with correct config', () => {
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    const win = wm.open('main')
    expect(win).toBeDefined()
    expect(wm.get('main')).toBe(win)
  })

  it('creates a hidden Windows title bar for renderer-drawn controls', () => {
    const wm = new WindowManager({
      settingsManager: createMockSettingsManager(),
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
      platform: 'win32',
    })

    const win = wm.open('main')
    const options = (win as unknown as { options: Record<string, unknown> })
      .options
    expect(options.titleBarStyle).toBe('hidden')
    expect(options.titleBarOverlay).toBeUndefined()
  })

  it('publishes the owning window maximize state after load and on changes', () => {
    const wm = new WindowManager({
      settingsManager: createMockSettingsManager(),
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
      platform: 'win32',
    })

    const win = wm.open('main')
    const webContentsListeners = (
      win.webContents.on as unknown as ReturnType<typeof vi.fn>
    ).mock.calls
    const windowListeners = (win.on as unknown as ReturnType<typeof vi.fn>).mock
      .calls
    const didFinishLoad = webContentsListeners.find(
      ([event]) => event === 'did-finish-load'
    )?.[1] as (() => void) | undefined
    const maximize = windowListeners.find(
      ([event]) => event === 'maximize'
    )?.[1] as (() => void) | undefined
    const unmaximize = windowListeners.find(
      ([event]) => event === 'unmaximize'
    )?.[1] as (() => void) | undefined
    const resized = windowListeners.find(
      ([event]) => event === 'resized'
    )?.[1] as (() => void) | undefined

    didFinishLoad?.()
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      Events.WindowMaximizedChanged,
      { maximized: false }
    )

    vi.mocked(win.isMaximized).mockReturnValue(true)
    maximize?.()
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      Events.WindowMaximizedChanged,
      { maximized: true }
    )

    // macOS can finish a manual resize without sending unmaximize. The final
    // geometry event must still reconcile the renderer caption state.
    vi.mocked(win.isMaximized).mockReturnValue(false)
    resized?.()
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      Events.WindowMaximizedChanged,
      { maximized: false }
    )

    vi.mocked(win.isMaximized).mockReturnValue(true)
    maximize?.()
    vi.mocked(win.isMaximized).mockReturnValue(false)
    unmaximize?.()
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      Events.WindowMaximizedChanged,
      { maximized: false }
    )
  })

  it('uses the explicit secure Electron renderer defaults', () => {
    const wm = new WindowManager({
      settingsManager: createMockSettingsManager(),
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    const win = wm.open('main')
    const options = (win as unknown as { options: Record<string, unknown> })
      .options

    expect(options.webPreferences).toEqual({
      preload: '/fake/preload.cjs',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    })
  })

  it.each(['win32', 'linux'])(
    'keeps the native menu bar hidden for every new %s window',
    (platform) => {
      const wm = new WindowManager({
        settingsManager: createMockSettingsManager(),
        preloadPath: '/fake/preload.cjs',
        loadUrl: vi.fn(),
        platform,
      })

      wm.open('main')
      wm.precreate('add-task')
      wm.recreate('main')

      const instances = (
        BrowserWindow as unknown as {
          instances: Array<{
            setAutoHideMenuBar: ReturnType<typeof vi.fn>
            setMenuBarVisibility: ReturnType<typeof vi.fn>
          }>
        }
      ).instances
      expect(instances).toHaveLength(3)
      for (const win of instances) {
        expect(win.setAutoHideMenuBar).toHaveBeenCalledExactlyOnceWith(false)
        expect(win.setMenuBarVisibility).toHaveBeenCalledExactlyOnceWith(false)
        expect(win.setAutoHideMenuBar.mock.invocationCallOrder[0]).toBeLessThan(
          win.setMenuBarVisibility.mock.invocationCallOrder[0]
        )
      }
    }
  )

  it.each(['darwin', 'web'])(
    'does not configure native menu bar visibility on %s',
    (platform) => {
      const wm = new WindowManager({
        settingsManager: createMockSettingsManager(),
        preloadPath: '/fake/preload.cjs',
        loadUrl: vi.fn(),
        platform,
      })

      const win = wm.open('main') as unknown as {
        setAutoHideMenuBar: ReturnType<typeof vi.fn>
        setMenuBarVisibility: ReturnType<typeof vi.fn>
      }

      expect(win.setAutoHideMenuBar).not.toHaveBeenCalled()
      expect(win.setMenuBarVisibility).not.toHaveBeenCalled()
    }
  )

  it('blocks navigation and redirects outside the trusted renderer URL', () => {
    const wm = new WindowManager({
      settingsManager: createMockSettingsManager(),
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })
    const win = wm.open('main')
    const on = win.webContents.on as ReturnType<typeof vi.fn>
    const navigate = on.mock.calls.find(
      ([event]) => event === 'will-navigate'
    )?.[1]
    const redirect = on.mock.calls.find(
      ([event]) => event === 'will-redirect'
    )?.[1]
    const trustedEvent = { preventDefault: vi.fn() }
    const externalEvent = { preventDefault: vi.fn() }
    const redirectEvent = { preventDefault: vi.fn() }

    navigate?.(trustedEvent, 'file:///app/dist/renderer/index.html?w=add-task')
    navigate?.(externalEvent, 'https://attacker.example/')
    redirect?.(redirectEvent, 'file:///tmp/attacker.html')

    expect(trustedEvent.preventDefault).not.toHaveBeenCalled()
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce()
    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce()
  })

  it('creates the main window with Liquid Glass chrome when enabled', () => {
    const sm = createMockSettingsManager()
    const liquidGlass = {
      shouldUseLiquidGlass: vi.fn(() => true),
      attach: vi.fn(),
    } as unknown as LiquidGlassController
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
      liquidGlass,
      platform: 'darwin',
    })

    const win = wm.open('main')

    const options = (win as unknown as { options: Record<string, unknown> })
      .options
    expect(options.transparent).toBe(true)
    expect(options.vibrancy).toBeUndefined()
    expect(liquidGlass.shouldUseLiquidGlass).toHaveBeenCalledOnce()
    expect(liquidGlass.attach).toHaveBeenCalledWith('main', win)
  })

  it('hides macOS traffic lights after attaching the main-window preview', () => {
    const sm = createMockSettingsManager()
    const liquidGlass = {
      shouldUseLiquidGlass: vi.fn(() => true),
      attach: vi.fn(),
    } as unknown as LiquidGlassController
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
      liquidGlass,
      platform: 'darwin',
      previewMacMenu: true,
    })

    const win = wm.open('main')
    const setWindowButtonVisibility = vi.mocked(win.setWindowButtonVisibility)

    expect(liquidGlass.attach).toHaveBeenCalledWith('main', win)
    expect(setWindowButtonVisibility).toHaveBeenCalledWith(false)
    expect(liquidGlass.attach).toHaveBeenCalledBefore(setWindowButtonVisibility)
  })

  it('creates the onboarding window with Liquid Glass chrome when enabled', () => {
    const sm = createMockSettingsManager()
    const liquidGlass = {
      shouldUseLiquidGlass: vi.fn(() => true),
      attach: vi.fn(),
    } as unknown as LiquidGlassController
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
      liquidGlass,
      platform: 'darwin',
    })

    const win = wm.open('onboarding')

    const options = (win as unknown as { options: Record<string, unknown> })
      .options
    expect(options.transparent).toBe(true)
    expect(options.vibrancy).toBeUndefined()
    expect(liquidGlass.shouldUseLiquidGlass).toHaveBeenCalledOnce()
    expect(liquidGlass.attach).toHaveBeenCalledWith('onboarding', win)
  })

  it('does not enable Liquid Glass for the add-task window', () => {
    const sm = createMockSettingsManager()
    const liquidGlass = {
      shouldUseLiquidGlass: vi.fn(() => true),
      attach: vi.fn(),
    } as unknown as LiquidGlassController
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
      liquidGlass,
    })

    wm.open('add-task')

    expect(liquidGlass.shouldUseLiquidGlass).not.toHaveBeenCalled()
    expect(liquidGlass.attach).not.toHaveBeenCalled()
  })

  it('routes every window-opening entry point through the startup gate', () => {
    const sm = createMockSettingsManager()
    const resolveOpenTarget = vi.fn(
      (_requested: string): 'onboarding' => 'onboarding'
    )
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
      resolveOpenTarget,
    })

    wm.open('main')
    wm.show('add-task')
    wm.precreate('add-task')

    expect(wm.get('main')).toBeNull()
    expect(wm.get('add-task')).toBeNull()
    expect(wm.get('onboarding')).not.toBeNull()
    expect(resolveOpenTarget).toHaveBeenCalledWith('main')
    expect(resolveOpenTarget).toHaveBeenCalledWith('add-task')
  })

  it('recreates the resolved startup-gate target instead of the requested window', () => {
    const sm = createMockSettingsManager()
    const resolveOpenTarget = vi.fn(
      (_requested: string): 'onboarding' => 'onboarding'
    )
    const loadUrl = vi.fn()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl,
      resolveOpenTarget,
    })

    const first = wm.open('onboarding')
    const recreated = wm.recreate('main')

    expect(resolveOpenTarget).toHaveBeenCalledWith('main')
    expect(wm.get('main')).toBeNull()
    expect(wm.get('onboarding')).toBe(recreated)
    expect(recreated).not.toBe(first)
    expect(first.isDestroyed()).toBe(true)
    expect(loadUrl).toHaveBeenLastCalledWith(
      recreated,
      WINDOW_CONFIGS.onboarding.route
    )
  })

  it('returns existing window on second open call', () => {
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    const win1 = wm.open('main')
    const win2 = wm.open('main')
    expect(win1).toBe(win2)
    expect(win1.show).toHaveBeenCalled()
  })

  it('precreates a hidden window', () => {
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    wm.precreate('add-task')
    const win = wm.get('add-task')
    expect(win).toBeDefined()
    expect(win?.isVisible()).toBe(false)
  })

  it('close hides main window', () => {
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    wm.open('main')
    wm.close('main')
    const win = wm.get('main')
    expect(win).toBeDefined()
    expect(win?.hide).toHaveBeenCalled()
  })

  it('close releases main window when the live retention policy requests it', () => {
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
      retentionPolicy: {
        releaseMainOnDismiss: () => true,
        prewarmAddTask: () => false,
      },
    })

    const win = wm.open('main')
    wm.close('main')

    expect(win.hide).not.toHaveBeenCalled()
    expect(win.destroy).toHaveBeenCalledOnce()
    expect(wm.get('main')).toBeNull()
    expect(sm.update).toHaveBeenCalledWith({
      windowState: { main: expect.any(Object) },
    })
  })

  it('toggle releases a focused main window in lightweight mode', () => {
    const wm = new WindowManager({
      settingsManager: createMockSettingsManager(),
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
      retentionPolicy: {
        releaseMainOnDismiss: () => true,
        prewarmAddTask: () => false,
      },
    })

    const win = wm.open('main')
    win.show()
    wm.toggle('main')

    expect(win.destroy).toHaveBeenCalledOnce()
    expect(wm.get('main')).toBeNull()
  })

  it('stops converting main-window close into hide after update quit starts', () => {
    const wm = new WindowManager({
      settingsManager: createMockSettingsManager(),
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })
    const win = wm.open('main')
    const closeListener = (
      win.on as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.find(([event]) => event === 'close')?.[1] as
      | ((event: { preventDefault(): void }) => void)
      | undefined
    expect(closeListener).toBeTypeOf('function')

    const ordinaryClose = { preventDefault: vi.fn() }
    closeListener?.(ordinaryClose)
    expect(ordinaryClose.preventDefault).toHaveBeenCalledOnce()
    expect(win.hide).toHaveBeenCalledOnce()

    vi.mocked(win.hide).mockClear()
    wm.setWillQuit(true)
    const updateClose = { preventDefault: vi.fn() }
    closeListener?.(updateClose)

    expect(updateClose.preventDefault).not.toHaveBeenCalled()
    expect(win.hide).not.toHaveBeenCalled()
  })

  it('allows a native main-window close to destroy the renderer in lightweight mode', () => {
    const wm = new WindowManager({
      settingsManager: createMockSettingsManager(),
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
      retentionPolicy: {
        releaseMainOnDismiss: () => true,
        prewarmAddTask: () => false,
      },
    })
    const win = wm.open('main')
    const closeListener = (
      win.on as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.find(([event]) => event === 'close')?.[1] as
      | ((event: { preventDefault(): void }) => void)
      | undefined
    const closeEvent = { preventDefault: vi.fn() }

    closeListener?.(closeEvent)

    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    expect(win.hide).not.toHaveBeenCalled()

    const closedListener = (
      win.once as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.find(([event]) => event === 'closed')?.[1] as
      | (() => void)
      | undefined
    closedListener?.()
    expect(wm.get('main')).toBeNull()
  })

  it('reports both early and terminal Windows session-end signals', () => {
    const onSessionEnd = vi.fn()
    const wm = new WindowManager({
      settingsManager: createMockSettingsManager(),
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
      onSessionEnd,
    })
    const win = wm.open('main')
    const listeners = (win.on as unknown as ReturnType<typeof vi.fn>).mock.calls
    const querySessionEnd = listeners.find(
      ([event]) => event === 'query-session-end'
    )?.[1] as (() => void) | undefined
    const sessionEnd = listeners.find(
      ([event]) => event === 'session-end'
    )?.[1] as (() => void) | undefined

    querySessionEnd?.()
    sessionEnd?.()

    expect(onSessionEnd).toHaveBeenCalledTimes(2)
  })

  it('close destroys add-task window', () => {
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    wm.open('add-task')
    wm.close('add-task')
    expect(wm.get('add-task')).toBeNull()
  })

  it('does not recycle add-task in lightweight mode', () => {
    const wm = new WindowManager({
      settingsManager: createMockSettingsManager(),
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
      retentionPolicy: {
        releaseMainOnDismiss: () => true,
        prewarmAddTask: () => false,
      },
    })

    wm.open('add-task')
    wm.closeAndRecycle('add-task')

    expect(wm.get('add-task')).toBeNull()
    expect(
      (BrowserWindow as unknown as { instances: unknown[] }).instances
    ).toHaveLength(1)
  })

  it('preserves add-task recycling in the default retention mode', () => {
    const wm = new WindowManager({
      settingsManager: createMockSettingsManager(),
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    wm.open('add-task')
    wm.closeAndRecycle('add-task')

    expect(wm.get('add-task')).not.toBeNull()
    expect(
      (BrowserWindow as unknown as { instances: unknown[] }).instances
    ).toHaveLength(2)
  })

  it('reconciles a hidden prewarmed add-task after lightweight mode is enabled', () => {
    let lightweight = false
    const wm = new WindowManager({
      settingsManager: createMockSettingsManager(),
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
      retentionPolicy: {
        releaseMainOnDismiss: () => lightweight,
        prewarmAddTask: () => !lightweight,
      },
    })

    wm.precreate('add-task')
    const prewarmed = wm.get('add-task')
    lightweight = true
    wm.reconcileWindowRetention()

    expect(prewarmed?.destroy).toHaveBeenCalledOnce()
    expect(wm.get('add-task')).toBeNull()
  })

  it('restores saved bounds if within screen', () => {
    const savedBounds = { x: 100, y: 100, width: 1024, height: 768 }
    const sm = createMockSettingsManager({ main: savedBounds })
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    const win = wm.open('main')
    expect(win.setBounds).toHaveBeenCalledWith(savedBounds)
  })

  it('saves normal bounds and maximized state for a maximized window', () => {
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })
    const win = wm.open('main')
    const normalBounds = { x: 120, y: 80, width: 1100, height: 760 }
    vi.mocked(win.getNormalBounds).mockReturnValue(normalBounds)
    vi.mocked(win.isMaximized).mockReturnValue(true)

    wm.saveBounds('main')

    expect(sm.update).toHaveBeenCalledWith({
      windowState: { main: { ...normalBounds, maximized: true } },
    })
    expect(win.getBounds).not.toHaveBeenCalled()
  })

  it('restores normal bounds before re-maximizing a window', () => {
    const savedState = {
      x: 100,
      y: 100,
      width: 1024,
      height: 768,
      maximized: true,
    }
    const wm = new WindowManager({
      settingsManager: createMockSettingsManager({ main: savedState }),
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    const win = wm.open('main')

    expect(win.setBounds).toHaveBeenCalledWith({
      x: 100,
      y: 100,
      width: 1024,
      height: 768,
    })
    expect(win.maximize).toHaveBeenCalledOnce()
  })

  it('ignores saved bounds if outside all screens', () => {
    const savedBounds = { x: 5000, y: 5000, width: 1024, height: 768 }
    const sm = createMockSettingsManager({ main: savedBounds })
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    const win = wm.open('main')
    expect(win.setBounds).not.toHaveBeenCalledWith(savedBounds)
    expect(win.center).toHaveBeenCalled()
  })

  it('getWindowIdBySender finds window by webContents', () => {
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    const win = wm.open('main')
    const id = wm.getWindowIdBySender(win.webContents)
    expect(id).toBe('main')
  })

  it('broadcast sends to all windows', () => {
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    wm.open('main')
    wm.open('add-task')
    wm.broadcast('event:taskUpdated', { test: true })

    const wins = wm.getAllWindows()
    for (const win of wins) {
      expect(win.webContents.send).toHaveBeenCalledWith('event:taskUpdated', {
        test: true,
      })
    }
  })

  it('continues broadcasting when a window is destroyed during send', () => {
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    const first = wm.open('main')
    const second = wm.open('add-task')
    const firstSend = first.webContents.send as ReturnType<typeof vi.fn>
    firstSend.mockImplementationOnce(() => {
      throw new Error('render frame was disposed')
    })

    expect(() =>
      wm.broadcast(Events.LocaleChanged, { language: 'zh-CN' })
    ).not.toThrow()
    expect(second.webContents.send).toHaveBeenCalledWith(Events.LocaleChanged, {
      language: 'zh-CN',
    })
  })

  it('show recreates add-task window after it was destroyed', () => {
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    // Simulate: precreate → show → user clicks traffic-light (destroys)
    wm.precreate('add-task')
    wm.show('add-task')
    wm.close('add-task')
    expect(wm.get('add-task')).toBeNull()

    // Before the fix, this call would be a silent no-op.
    wm.show('add-task')
    const after = wm.get('add-task')
    expect(after).not.toBeNull()
    expect(after?.show).toHaveBeenCalled()
  })

  it('cold-start magnet: add-task wins focus when main paints last', () => {
    // Reproduces the cold-start race: app.on('ready') opens main, then
    // launcher.flushDeferred → protocolManager → show('add-task') runs
    // synchronously. Both windows have pending ready-to-show events;
    // whichever fires later normally steals focus. With lastFocusRequested
    // tracking, main's ready-to-show should fall back to showInactive.
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })
    wm.open('main', { show: true })
    wm.show('add-task')

    const mainWin = wm.get('main') as unknown as {
      show: ReturnType<typeof vi.fn>
      showInactive: ReturnType<typeof vi.fn>
      fireReadyToShow: () => void
    }
    const addTaskWin = wm.get('add-task') as unknown as {
      show: ReturnType<typeof vi.fn>
      showInactive: ReturnType<typeof vi.fn>
      fireReadyToShow: () => void
    }

    // Clear the synchronous show() invocation from wm.show('add-task') so
    // we can assert only what the ready-to-show handler does.
    mainWin.show.mockClear()
    addTaskWin.show.mockClear()

    // Main paints last — without the fix this would steal focus.
    addTaskWin.fireReadyToShow()
    mainWin.fireReadyToShow()

    expect(addTaskWin.show).toHaveBeenCalled()
    expect(mainWin.show).not.toHaveBeenCalled()
    expect(mainWin.showInactive).toHaveBeenCalled()
  })

  it('normal cold-start: main shows with focus when no other window requested', () => {
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })
    wm.open('main', { show: true })

    const mainWin = wm.get('main') as unknown as {
      show: ReturnType<typeof vi.fn>
      showInactive: ReturnType<typeof vi.fn>
      fireReadyToShow: () => void
    }
    mainWin.show.mockClear()
    mainWin.fireReadyToShow()

    expect(mainWin.show).toHaveBeenCalled()
    expect(mainWin.showInactive).not.toHaveBeenCalled()
  })

  it('show with mode=torrent sends SetAddTaskMode IPC event to the window', () => {
    vi.useFakeTimers()
    const sm = createMockSettingsManager()
    const wm = new WindowManager({
      settingsManager: sm,
      preloadPath: '/fake/preload.cjs',
      loadUrl: vi.fn(),
    })

    wm.open('add-task')
    const win = wm.get('add-task')
    expect(win).not.toBeNull()
    if (!win) return
    const sendMock = win.webContents.send as ReturnType<typeof vi.fn>
    sendMock.mockClear()

    wm.show('add-task', { mode: 'torrent' })
    vi.advanceTimersByTime(100)

    expect(sendMock).toHaveBeenCalledWith(Events.SetAddTaskMode, {
      mode: 'torrent',
    })
    vi.useRealTimers()
  })
})
