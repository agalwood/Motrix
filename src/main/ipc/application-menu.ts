import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type ApplicationMenuSnapshot,
  applicationMenuSnapshotSchema,
  type ExecuteApplicationMenuItemRequest,
  executeApplicationMenuItemRequestSchema,
} from '@shared/schemas/application-menu'
import { type BrowserWindow, ipcMain } from 'electron'
import { registerTrustedIpcHandler } from './trusted-ipc'

export interface ApplicationMenuIpcDeps {
  menuManager: {
    getApplicationMenuSnapshot(): ApplicationMenuSnapshot
    executeApplicationMenuItem(
      request: ExecuteApplicationMenuItemRequest,
      targetWindow: BrowserWindow
    ): void | Promise<void>
    onApplicationMenuChanged(
      listener: (snapshot: ApplicationMenuSnapshot) => void
    ): () => void
  }
  windowManager: {
    get(id: 'main'): BrowserWindow | null
    getWindowIdBySender(sender: Electron.WebContents): string | null
  }
  trackAsyncWork?: <T>(operation: () => Promise<T>) => Promise<T>
}

function requireMainWindow(
  event: Electron.IpcMainInvokeEvent,
  deps: ApplicationMenuIpcDeps
): BrowserWindow {
  const mainWindow = deps.windowManager.get('main')
  if (
    deps.windowManager.getWindowIdBySender(event.sender) !== 'main' ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents !== event.sender
  ) {
    throw new Error('Blocked application-menu IPC call from a non-main window')
  }
  return mainWindow
}

function sendSnapshotToMain(
  snapshot: ApplicationMenuSnapshot,
  deps: ApplicationMenuIpcDeps
): void {
  const mainWindow = deps.windowManager.get('main')
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed?.()
  ) {
    return
  }
  const parsed = applicationMenuSnapshotSchema.parse(snapshot)
  try {
    mainWindow.webContents.send(Events.ApplicationMenuChanged, parsed)
  } catch {
    // A main window can be destroyed between the guards above and send().
  }
}

function runTracked<T>(
  deps: ApplicationMenuIpcDeps,
  operation: () => T | Promise<T>
): Promise<T> {
  const run = async () => operation()
  return deps.trackAsyncWork ? deps.trackAsyncWork(run) : run()
}

export function registerApplicationMenuIpc(
  deps: ApplicationMenuIpcDeps
): () => void {
  registerTrustedIpcHandler(Queries.GetApplicationMenu, async (event) => {
    return runTracked(deps, () => {
      requireMainWindow(event, deps)
      return applicationMenuSnapshotSchema.parse(
        deps.menuManager.getApplicationMenuSnapshot()
      )
    })
  })

  registerTrustedIpcHandler(
    Commands.ExecuteApplicationMenuItem,
    async (event, input: unknown) => {
      return runTracked(deps, async () => {
        const mainWindow = requireMainWindow(event, deps)
        const request = executeApplicationMenuItemRequestSchema.parse(input)
        await deps.menuManager.executeApplicationMenuItem(request, mainWindow)
        return { ok: true }
      })
    }
  )

  const offMenuChanged = deps.menuManager.onApplicationMenuChanged((snapshot) =>
    sendSnapshotToMain(snapshot, deps)
  )
  sendSnapshotToMain(deps.menuManager.getApplicationMenuSnapshot(), deps)

  return () => {
    offMenuChanged()
    ipcMain.removeHandler(Queries.GetApplicationMenu)
    ipcMain.removeHandler(Commands.ExecuteApplicationMenuItem)
  }
}
