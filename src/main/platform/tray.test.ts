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
import { setupTray, type TrayDeps } from './tray'

const originalPlatform = process.platform
const toggleMainWindow = vi.fn()
function createDeps(): TrayDeps {
  return {
    eventBus: {
      off: vi.fn(),
      on: vi.fn(),
    },
    settingsManager: {
      getApp: () => ({
        runMode: RunMode.Standard,
        traySpeedometer: false,
      }),
    },
    menuManager: {
      getTrayMenu: () => null,
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
  it('toggles the main window on left click on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const handle = setupTray(createDeps())

    await vi.waitFor(() => {
      expect(trayConstructor).toHaveBeenCalled()
    })

    const clickHandler = trayInstance.on.mock.calls.find(
      ([event]) => event === 'click'
    )?.[1] as (() => void) | undefined

    expect(clickHandler).toBeDefined()

    clickHandler?.()

    expect(toggleMainWindow).toHaveBeenCalledOnce()
    expect(trayInstance.popUpContextMenu).not.toHaveBeenCalled()

    handle.destroy()
  })
})
