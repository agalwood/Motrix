import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { ApplicationMenuSnapshot } from '@shared/schemas/application-menu'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handle, removeHandler } = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle, removeHandler },
}))

vi.mock('./trusted-ipc', () => ({
  registerTrustedIpcHandler: (
    channel: string,
    listener: (...args: never[]) => unknown
  ) => handle(channel, listener),
}))

import {
  type ApplicationMenuIpcDeps,
  registerApplicationMenuIpc,
} from './application-menu'

const initialSnapshot: ApplicationMenuSnapshot = {
  revision: 1,
  items: [
    {
      id: 'menubar.task',
      type: 'submenu',
      label: 'Task',
      enabled: true,
      visible: true,
      children: [
        {
          id: 'task.pause',
          type: 'normal',
          label: 'Pause',
          enabled: true,
          visible: true,
        },
      ],
    },
  ],
}

function createDeps() {
  let changedListener: ((snapshot: ApplicationMenuSnapshot) => void) | undefined
  const offMenuChanged = vi.fn()
  const mainWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
  }
  const menuManager = {
    getApplicationMenuSnapshot: vi.fn(() => initialSnapshot),
    executeApplicationMenuItem: vi.fn().mockResolvedValue(undefined),
    onApplicationMenuChanged: vi.fn(
      (listener: (snapshot: ApplicationMenuSnapshot) => void) => {
        changedListener = listener
        return offMenuChanged
      }
    ),
  }
  const windowManager = {
    get: vi.fn((id: 'main') => (id === 'main' ? mainWindow : null)),
    getWindowIdBySender: vi.fn((sender: unknown) =>
      sender === mainWindow.webContents ? 'main' : 'add-task'
    ),
  }

  return {
    deps: { menuManager, windowManager } as unknown as ApplicationMenuIpcDeps,
    mainWindow,
    menuManager,
    offMenuChanged,
    emitChanged: (snapshot: ApplicationMenuSnapshot) =>
      changedListener?.(snapshot),
  }
}

function registeredHandler(channel: string) {
  return handle.mock.calls.find(([registered]) => registered === channel)?.[1]
}

describe('application-menu IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers the query and execute channels and pushes the initial snapshot only to main', () => {
    const { deps, mainWindow, menuManager } = createDeps()

    registerApplicationMenuIpc(deps)

    expect(handle).toHaveBeenCalledTimes(2)
    expect(handle).toHaveBeenCalledWith(
      Queries.GetApplicationMenu,
      expect.any(Function)
    )
    expect(handle).toHaveBeenCalledWith(
      Commands.ExecuteApplicationMenuItem,
      expect.any(Function)
    )
    expect(menuManager.onApplicationMenuChanged).toHaveBeenCalledOnce()
    expect(mainWindow.webContents.send).toHaveBeenCalledOnce()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      Events.ApplicationMenuChanged,
      initialSnapshot
    )
  })

  it('returns the current validated snapshot to the main renderer', async () => {
    const { deps, mainWindow } = createDeps()
    registerApplicationMenuIpc(deps)
    const query = registeredHandler(Queries.GetApplicationMenu)

    await expect(query({ sender: mainWindow.webContents })).resolves.toEqual(
      initialSnapshot
    )
  })

  it('rejects query and execute calls from any renderer except current main', async () => {
    const { deps } = createDeps()
    registerApplicationMenuIpc(deps)
    const event = { sender: {} }
    const request = {
      itemId: 'task.pause',
      revision: 1,
      trigger: 'menu',
      selectedTaskId: null,
    }

    await expect(
      registeredHandler(Queries.GetApplicationMenu)(event)
    ).rejects.toThrow('non-main window')
    await expect(
      registeredHandler(Commands.ExecuteApplicationMenuItem)(event, request)
    ).rejects.toThrow('non-main window')
  })

  it('requires the sender to match the current main even when its id is spoofed', async () => {
    const { deps } = createDeps()
    deps.windowManager.getWindowIdBySender = vi.fn(() => 'main')
    registerApplicationMenuIpc(deps)

    await expect(
      registeredHandler(Queries.GetApplicationMenu)({ sender: {} })
    ).rejects.toThrow('non-main window')
  })

  it('strictly parses execute input and passes the current main BrowserWindow', async () => {
    const { deps, mainWindow, menuManager } = createDeps()
    registerApplicationMenuIpc(deps)
    const execute = registeredHandler(Commands.ExecuteApplicationMenuItem)
    const request = {
      itemId: 'task.pause',
      revision: 1,
      trigger: 'menu',
      selectedTaskId: null,
      modifiers: {
        alt: false,
        control: true,
        meta: false,
        shift: false,
      },
    }

    await expect(
      execute({ sender: mainWindow.webContents }, request)
    ).resolves.toEqual({ ok: true })
    expect(menuManager.executeApplicationMenuItem).toHaveBeenCalledWith(
      request,
      mainWindow
    )

    await expect(
      execute(
        { sender: mainWindow.webContents },
        { ...request, unexpected: true }
      )
    ).rejects.toThrow()
    expect(menuManager.executeApplicationMenuItem).toHaveBeenCalledOnce()
  })

  it('pushes changes only to the current main window and skips a destroyed main', () => {
    const { deps, emitChanged, mainWindow } = createDeps()
    registerApplicationMenuIpc(deps)
    mainWindow.webContents.send.mockClear()
    const changedSnapshot = { ...initialSnapshot, revision: 2 }

    emitChanged(changedSnapshot)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      Events.ApplicationMenuChanged,
      changedSnapshot
    )

    mainWindow.isDestroyed.mockReturnValue(true)
    emitChanged({ ...initialSnapshot, revision: 3 })
    expect(mainWindow.webContents.send).toHaveBeenCalledOnce()
  })

  it('skips destroyed webContents and tolerates a send destruction race', () => {
    const { deps, emitChanged, mainWindow } = createDeps()
    registerApplicationMenuIpc(deps)
    mainWindow.webContents.send.mockClear()

    mainWindow.webContents.isDestroyed.mockReturnValue(true)
    emitChanged({ ...initialSnapshot, revision: 2 })
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()

    mainWindow.webContents.isDestroyed.mockReturnValue(false)
    mainWindow.webContents.send.mockImplementationOnce(() => {
      throw new Error('destroyed')
    })
    expect(() => emitChanged({ ...initialSnapshot, revision: 3 })).not.toThrow()
  })

  it('tracks both snapshot queries and menu-item execution', async () => {
    const { deps, mainWindow } = createDeps()
    const trackedOperations: Array<() => Promise<unknown>> = []
    const trackAsyncWork = <T>(operation: () => Promise<T>): Promise<T> => {
      trackedOperations.push(operation)
      return operation()
    }
    deps.trackAsyncWork = trackAsyncWork
    registerApplicationMenuIpc(deps)

    await registeredHandler(Queries.GetApplicationMenu)({
      sender: mainWindow.webContents,
    })
    await registeredHandler(Commands.ExecuteApplicationMenuItem)(
      { sender: mainWindow.webContents },
      {
        itemId: 'task.pause',
        revision: 1,
        trigger: 'menu',
        selectedTaskId: null,
      }
    )

    expect(trackedOperations).toHaveLength(2)
  })

  it('revalidates the current main window after tracked work is admitted', async () => {
    const { deps, mainWindow, menuManager } = createDeps()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    deps.trackAsyncWork = async (operation) => {
      await gate
      return operation()
    }
    registerApplicationMenuIpc(deps)
    const execution = registeredHandler(Commands.ExecuteApplicationMenuItem)(
      { sender: mainWindow.webContents },
      {
        itemId: 'task.pause',
        revision: 1,
        trigger: 'menu',
        selectedTaskId: null,
      }
    )

    mainWindow.isDestroyed.mockReturnValue(true)
    release?.()

    await expect(execution).rejects.toThrow('non-main window')
    expect(menuManager.executeApplicationMenuItem).not.toHaveBeenCalled()
  })

  it('removes both handlers and the menu listener on dispose', () => {
    const { deps, offMenuChanged } = createDeps()
    const dispose = registerApplicationMenuIpc(deps)

    dispose()

    expect(offMenuChanged).toHaveBeenCalledOnce()
    expect(removeHandler).toHaveBeenCalledTimes(2)
    expect(removeHandler).toHaveBeenCalledWith(Queries.GetApplicationMenu)
    expect(removeHandler).toHaveBeenCalledWith(
      Commands.ExecuteApplicationMenuItem
    )
  })
})
