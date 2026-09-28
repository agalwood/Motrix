import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appDock,
  iconProviderFactory,
  icon,
  iconProvider,
  nativeThemeMock,
  speedometer,
  systemPreferencesMock,
  trayConstructor,
  trayInstance,
} = vi.hoisted(() => {
  const trayInstance = {
    destroy: vi.fn(),
    on: vi.fn(),
    popUpContextMenu: vi.fn(),
    removeAllListeners: vi.fn(),
    setContextMenu: vi.fn(),
    setIgnoreDoubleClickEvents: vi.fn(),
    setImage: vi.fn(),
    setToolTip: vi.fn(),
  }

  return {
    appDock: { hide: vi.fn(), show: vi.fn() },
    iconProviderFactory: vi.fn(),
    icon: { kind: 'tray-icon' },
    iconProvider: {
      getIcon: vi.fn(),
      init: vi.fn(),
    },
    nativeThemeMock: { on: vi.fn(), off: vi.fn() },
    speedometer: {
      destroy: vi.fn(),
      onSpeedChange: vi.fn(),
      setEnabled: vi.fn(),
      setUnitSystem: vi.fn(),
    },
    systemPreferencesMock: {
      getUserDefault: vi.fn(),
      setUserDefault: vi.fn(),
    },
    trayConstructor: vi.fn(),
    trayInstance,
  }
})

vi.mock('electron', () => ({
  app: { dock: appDock },
  nativeTheme: nativeThemeMock,
  systemPreferences: systemPreferencesMock,
  Tray: class {
    destroy = trayInstance.destroy
    on = trayInstance.on
    popUpContextMenu = trayInstance.popUpContextMenu
    removeAllListeners = trayInstance.removeAllListeners
    setContextMenu = trayInstance.setContextMenu
    setIgnoreDoubleClickEvents = trayInstance.setIgnoreDoubleClickEvents
    setImage = trayInstance.setImage
    setToolTip = trayInstance.setToolTip

    constructor(...args: unknown[]) {
      trayConstructor(...args)
    }
  },
}))

vi.mock('@core/logger', () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn() }),
}))

vi.mock('./tray-icon', () => ({
  createIconProvider: iconProviderFactory,
}))

vi.mock('./tray-speedometer', () => ({
  createSpeedometer: () => speedometer,
}))

import { RunMode } from '@shared/constants'
import { Events } from '@shared/protocol/events'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas'
import type { MotrixAppSettings } from '@shared/types/settings'
import { setupTray, type TrayDeps } from './tray'

const originalPlatform = process.platform
const trayMenu = { kind: 'tray-menu' }
const toggleMainWindow = vi.fn()

function createDeps(appSettings: Partial<MotrixAppSettings> = {}): TrayDeps {
  const settings = { ...DEFAULT_APP_SETTINGS, ...appSettings }
  return {
    eventBus: {
      off: vi.fn(),
      on: vi.fn(),
    },
    settingsManager: { getApp: () => settings },
    menuManager: {
      getTrayMenu: () => trayMenu,
      onTrayRebuilt: vi.fn(),
    },
    protocolManager: {
      handle: vi.fn(),
      handleTorrentFile: vi.fn(),
    },
    extraResourceDir: path.join(process.cwd(), 'extra'),
    toggleMainWindow,
  } as unknown as TrayDeps
}

function getTrayHandler(eventName: string): () => void {
  const handler = trayInstance.on.mock.calls.find(
    ([event]) => event === eventName
  )?.[1]

  expect(handler).toBeTypeOf('function')
  return handler as () => void
}

function getThemeUpdatedHandler(): () => Promise<void> {
  const handler = nativeThemeMock.on.mock.calls.find(
    ([event]) => event === 'updated'
  )?.[1]
  expect(handler).toBeTypeOf('function')
  return handler as () => Promise<void>
}

describe('setupTray', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    iconProviderFactory.mockReturnValue(iconProvider)
    iconProvider.getIcon.mockReturnValue(icon)
    iconProvider.init.mockResolvedValue(undefined)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('uses a stable GUID on macOS so the system can restore its position', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    const handle = setupTray(createDeps())

    await vi.waitFor(() => {
      expect(trayConstructor).toHaveBeenCalledWith(
        icon,
        '493f17b6-d4ac-48d3-8723-c3ac490b14cf'
      )
    })

    handle.destroy()
  })

  it('does not pass the macOS GUID on other platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })

    const handle = setupTray(createDeps())

    await vi.waitFor(() => {
      expect(trayConstructor).toHaveBeenCalledWith(icon)
    })

    handle.destroy()
  })

  it('keeps the native macOS tray alive while preparing to quit', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const deps = createDeps()
    const handle = setupTray(deps)
    await vi.waitFor(() => expect(trayConstructor).toHaveBeenCalledOnce())

    handle.prepareForQuit()

    expect(trayInstance.removeAllListeners).toHaveBeenCalledOnce()
    expect(speedometer.destroy).toHaveBeenCalledOnce()
    expect(trayInstance.destroy).not.toHaveBeenCalled()
    expect(deps.eventBus.off).toHaveBeenCalledTimes(3)
  })

  it('does not finish creating a tray after shutdown starts', async () => {
    let resolveInit: () => void = () => {}
    iconProvider.init.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve
        })
    )
    const handle = setupTray(createDeps())

    handle.prepareForQuit()
    resolveInit()
    await Promise.resolve()

    expect(iconProvider.init).toHaveBeenCalledOnce()
    expect(trayConstructor).not.toHaveBeenCalled()
  })

  it('keeps Linux activity changes received while tray icons are loading', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const pending = Promise.withResolvers<void>()
    iconProvider.init.mockReturnValueOnce(pending.promise)
    const deps = createDeps()
    const handle = setupTray(deps)
    const activeChanged = vi
      .mocked(deps.eventBus.on)
      .mock.calls.find(([event]) => event === Events.EngineActiveChanged)?.[1]
    activeChanged?.(true)
    pending.resolve()
    await vi.waitFor(() => expect(trayConstructor).toHaveBeenCalledOnce())
    expect(iconProvider.getIcon).toHaveBeenLastCalledWith(true)
    handle.destroy()
  })

  it.each(['win32', 'linux'])(
    'destroys the native tray while preparing to quit on %s',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform })
      const handle = setupTray(createDeps())
      await vi.waitFor(() => expect(trayConstructor).toHaveBeenCalledOnce())

      handle.prepareForQuit()

      expect(trayInstance.destroy).toHaveBeenCalledOnce()
    }
  )

  it.each([false, true])(
    'refreshes Linux icons on theme changes and preserves active=%s',
    async (active) => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const deps = createDeps()
      const handle = setupTray(deps)
      await vi.waitFor(() => expect(trayConstructor).toHaveBeenCalledOnce())

      const activeChanged = vi
        .mocked(deps.eventBus.on)
        .mock.calls.find(([event]) => event === Events.EngineActiveChanged)?.[1]
      expect(activeChanged).toBeTypeOf('function')
      activeChanged?.(active)
      trayInstance.setImage.mockClear()

      const updatedIcon = { kind: 'updated-theme-icon' }
      iconProvider.getIcon.mockReturnValue(updatedIcon)
      await getThemeUpdatedHandler()()

      expect(iconProvider.init).toHaveBeenCalledTimes(2)
      expect(iconProvider.getIcon).toHaveBeenLastCalledWith(active)
      expect(trayInstance.setImage).toHaveBeenCalledExactlyOnceWith(updatedIcon)
      expect(trayConstructor).toHaveBeenCalledOnce()
      handle.destroy()
    }
  )

  it.each(['linux', 'win32'])(
    'updates activity on %s even with the default macOS speedometer preference',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform })
      const deps = createDeps()
      expect(deps.settingsManager.getApp().traySpeedometer).toBe(true)
      const handle = setupTray(deps)
      await vi.waitFor(() => expect(trayConstructor).toHaveBeenCalledOnce())
      const activeChanged = vi
        .mocked(deps.eventBus.on)
        .mock.calls.find(([event]) => event === Events.EngineActiveChanged)?.[1]
      for (const active of [true, false]) {
        trayInstance.setImage.mockClear()
        activeChanged?.(active)
        expect(iconProvider.getIcon).toHaveBeenLastCalledWith(active)
        expect(trayInstance.setImage).toHaveBeenCalledExactlyOnceWith(icon)
      }
      expect(speedometer.setEnabled).not.toHaveBeenCalled()
      handle.destroy()
    }
  )

  it('does not replace an enabled macOS speedometer on activity changes', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const deps = createDeps()
    const handle = setupTray(deps)
    await vi.waitFor(() => expect(trayConstructor).toHaveBeenCalledOnce())
    const activeChanged = vi
      .mocked(deps.eventBus.on)
      .mock.calls.find(([event]) => event === Events.EngineActiveChanged)?.[1]
    activeChanged?.(true)
    expect(speedometer.setEnabled).toHaveBeenCalledWith(true)
    expect(trayInstance.setImage).not.toHaveBeenCalled()
    handle.destroy()
  })

  it('applies Linux color changes immediately and resumes automatic theme updates', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const deps = createDeps()
    const handle = setupTray(deps)
    await vi.waitFor(() => expect(trayConstructor).toHaveBeenCalledOnce())
    const activeChanged = vi
      .mocked(deps.eventBus.on)
      .mock.calls.find(([event]) => event === Events.EngineActiveChanged)?.[1]
    const settingsChanged = vi
      .mocked(deps.eventBus.on)
      .mock.calls.find(([event]) => event === Events.SettingsChanged)?.[1]
    activeChanged?.(true)
    const getColor = iconProviderFactory.mock.calls[0]?.[2]
    expect(getColor).toBeTypeOf('function')

    for (const trayIconColor of ['light', 'dark', 'auto'] as const) {
      const old = { app: { ...deps.settingsManager.getApp() } }
      deps.settingsManager.getApp().trayIconColor = trayIconColor
      trayInstance.setImage.mockClear()
      settingsChanged?.({
        old,
        updated: { app: deps.settingsManager.getApp() },
      })
      await vi.waitFor(() =>
        expect(trayInstance.setImage).toHaveBeenCalledExactlyOnceWith(icon)
      )
      expect(getColor()).toBe(trayIconColor)
      expect(iconProvider.getIcon).toHaveBeenLastCalledWith(true)
      expect(trayConstructor).toHaveBeenCalledOnce()

      iconProvider.init.mockClear()
      trayInstance.setImage.mockClear()
      await getThemeUpdatedHandler()()
      if (trayIconColor === 'auto') {
        expect(iconProvider.init).toHaveBeenCalledOnce()
        expect(trayInstance.setImage).toHaveBeenCalledExactlyOnceWith(icon)
      } else {
        expect(iconProvider.init).not.toHaveBeenCalled()
        expect(trayInstance.setImage).not.toHaveBeenCalled()
      }
    }
    handle.destroy()
  })

  it.each(['darwin', 'win32'])(
    'does not reload native tray icons for theme changes on %s',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform })
      const handle = setupTray(createDeps())
      await vi.waitFor(() => expect(trayConstructor).toHaveBeenCalledOnce())

      expect(nativeThemeMock.on).not.toHaveBeenCalled()
      handle.destroy()
      expect(nativeThemeMock.off).not.toHaveBeenCalled()
    }
  )

  it('unsubscribes from theme updates when the Linux tray is destroyed', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const handle = setupTray(createDeps())
    await vi.waitFor(() => expect(trayConstructor).toHaveBeenCalledOnce())
    const onUpdated = getThemeUpdatedHandler()

    handle.destroy()
    expect(nativeThemeMock.off).toHaveBeenCalledExactlyOnceWith(
      'updated',
      onUpdated
    )
    await onUpdated()
    expect(iconProvider.init).toHaveBeenCalledOnce()
    expect(trayInstance.setImage).not.toHaveBeenCalled()
  })

  it('does not apply a pending theme refresh to a destroyed tray', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const handle = setupTray(createDeps())
    await vi.waitFor(() => expect(trayConstructor).toHaveBeenCalledOnce())
    const pending = Promise.withResolvers<void>()
    iconProvider.init.mockReturnValueOnce(pending.promise)

    const refresh = getThemeUpdatedHandler()()
    handle.destroy()
    pending.resolve()
    await refresh

    expect(trayInstance.setImage).not.toHaveBeenCalled()
  })

  it('keeps the existing icon if a Linux theme refresh fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const handle = setupTray(createDeps())
    await vi.waitFor(() => expect(trayConstructor).toHaveBeenCalledOnce())
    iconProvider.init.mockRejectedValueOnce(new Error('Image loading failed'))

    await expect(getThemeUpdatedHandler()()).resolves.toBeUndefined()

    expect(trayInstance.setImage).not.toHaveBeenCalled()
    handle.destroy()
  })

  it.each(['win32', 'linux'] as const)(
    'forces a tray for lightweight HideTray on %s',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform })

      const handle = setupTray(
        createDeps({
          lightweightMode: true,
          runMode: RunMode.HideTray,
          traySpeedometer: false,
        })
      )

      await vi.waitFor(() => {
        expect(trayConstructor).toHaveBeenCalled()
      })

      handle.destroy()
    }
  )

  it('keeps a tray for stale Linux HideTray as lightweight mode changes', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const deps = createDeps({
      lightweightMode: false,
      runMode: RunMode.HideTray,
      traySpeedometer: false,
    })
    const handle = setupTray(deps)
    await vi.waitFor(() => {
      expect(trayConstructor).toHaveBeenCalledOnce()
    })

    const settingsChanged = (
      deps.eventBus.on as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.find(([event]) => event === Events.SettingsChanged)?.[1] as
      | ((payload: unknown) => void)
      | undefined
    settingsChanged?.({
      old: {
        app: { lightweightMode: false, runMode: RunMode.HideTray },
      },
      updated: {
        app: { lightweightMode: true, runMode: RunMode.HideTray },
      },
    })

    settingsChanged?.({
      old: {
        app: { lightweightMode: true, runMode: RunMode.HideTray },
      },
      updated: {
        app: { lightweightMode: false, runMode: RunMode.HideTray },
      },
    })
    expect(trayConstructor).toHaveBeenCalledOnce()
    expect(trayInstance.destroy).not.toHaveBeenCalled()

    handle.destroy()
  })

  it('preserves the macOS tray position while switching through Dock-only mode', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    systemPreferencesMock.getUserDefault.mockReturnValue(486.5)
    const deps = createDeps()
    const handle = setupTray(deps)
    await vi.waitFor(() => expect(trayConstructor).toHaveBeenCalledOnce())
    appDock.show.mockClear()
    appDock.hide.mockClear()

    const settingsChanged = vi
      .mocked(deps.eventBus.on)
      .mock.calls.find(([event]) => event === Events.SettingsChanged)?.[1]
    expect(settingsChanged).toBeTypeOf('function')

    settingsChanged?.({
      old: { app: { lightweightMode: false, runMode: RunMode.Standard } },
      updated: { app: { lightweightMode: false, runMode: RunMode.HideTray } },
    })

    expect(
      systemPreferencesMock.getUserDefault
    ).toHaveBeenCalledExactlyOnceWith(
      'NSStatusItem Preferred Position 493f17b6-d4ac-48d3-8723-c3ac490b14cf',
      'double'
    )
    expect(trayInstance.destroy).toHaveBeenCalledOnce()
    expect(appDock.show).toHaveBeenCalledOnce()
    expect(appDock.hide).not.toHaveBeenCalled()
    expect(
      systemPreferencesMock.setUserDefault
    ).toHaveBeenCalledExactlyOnceWith(
      'NSStatusItem Preferred Position 493f17b6-d4ac-48d3-8723-c3ac490b14cf',
      'double',
      486.5
    )

    settingsChanged?.({
      old: { app: { lightweightMode: false, runMode: RunMode.HideTray } },
      updated: { app: { lightweightMode: false, runMode: RunMode.TrayOnly } },
    })
    await vi.waitFor(() => expect(trayConstructor).toHaveBeenCalledTimes(2))

    expect(appDock.hide).toHaveBeenCalledOnce()
    expect(trayConstructor).toHaveBeenLastCalledWith(
      icon,
      '493f17b6-d4ac-48d3-8723-c3ac490b14cf'
    )
    handle.prepareForQuit()
  })

  it('toggles the main window without opening the menu on Windows left click', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const handle = setupTray(createDeps())

    await vi.waitFor(() => {
      expect(trayInstance.on).toHaveBeenCalledWith(
        'click',
        expect.any(Function)
      )
    })

    getTrayHandler('click')()

    expect(toggleMainWindow).toHaveBeenCalledOnce()
    expect(trayInstance.popUpContextMenu).not.toHaveBeenCalled()

    handle.destroy()
  })

  it('opens the menu without toggling the window on Windows right click', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const handle = setupTray(createDeps())

    await vi.waitFor(() => {
      expect(trayInstance.on).toHaveBeenCalledWith(
        'right-click',
        expect.any(Function)
      )
    })

    getTrayHandler('right-click')()

    expect(trayInstance.popUpContextMenu).toHaveBeenCalledExactlyOnceWith(
      trayMenu
    )
    expect(toggleMainWindow).not.toHaveBeenCalled()

    handle.destroy()
  })

  it('opens the tray menu on macOS click', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    const handle = setupTray(createDeps())

    await vi.waitFor(() => {
      expect(trayInstance.on).toHaveBeenCalledWith(
        'click',
        expect.any(Function)
      )
    })

    getTrayHandler('click')()

    expect(trayInstance.popUpContextMenu).toHaveBeenCalledExactlyOnceWith(
      trayMenu
    )
    expect(toggleMainWindow).not.toHaveBeenCalled()

    handle.destroy()
  })

  it('toggles the main window on Linux activation and uses the bound menu', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })

    const handle = setupTray(createDeps())

    await vi.waitFor(() => {
      expect(trayInstance.on).toHaveBeenCalledWith(
        'click',
        expect.any(Function)
      )
    })

    getTrayHandler('click')()

    expect(toggleMainWindow).toHaveBeenCalledOnce()
    expect(trayInstance.setContextMenu).toHaveBeenCalledWith(trayMenu)
    expect(trayInstance.popUpContextMenu).not.toHaveBeenCalled()
    expect(trayInstance.on).not.toHaveBeenCalledWith(
      'right-click',
      expect.any(Function)
    )

    handle.destroy()
  })
})
