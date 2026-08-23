import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appDock,
  icon,
  iconProvider,
  speedometer,
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
    icon: { kind: 'tray-icon' },
    iconProvider: {
      getIcon: vi.fn(),
      init: vi.fn(),
    },
    speedometer: {
      destroy: vi.fn(),
      onSpeedChange: vi.fn(),
      setEnabled: vi.fn(),
    },
    trayConstructor: vi.fn(),
    trayInstance,
  }
})

vi.mock('electron', () => ({
  app: { dock: appDock },
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
  createIconProvider: () => iconProvider,
}))

vi.mock('./tray-speedometer', () => ({
  createSpeedometer: () => speedometer,
}))

import { RunMode } from '@shared/constants'
import { Events } from '@shared/protocol/events'
import { setupTray, type TrayDeps } from './tray'

const originalPlatform = process.platform
const trayMenu = { kind: 'tray-menu' }
const toggleMainWindow = vi.fn()

function createDeps(
  appSettings: {
    lightweightMode: boolean
    runMode: RunMode
    traySpeedometer: boolean
  } = {
    lightweightMode: false,
    runMode: RunMode.Standard,
    traySpeedometer: false,
  }
): TrayDeps {
  return {
    eventBus: {
      off: vi.fn(),
      on: vi.fn(),
    },
    settingsManager: { getApp: () => appSettings },
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

describe('setupTray', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
