import { BrowserWindow, ipcMain } from 'electron'
import {
  getRendererUrlPolicy,
  type RendererUrlPolicy,
} from '../window/renderer-url-policy'

export function isTrustedRendererUrl(
  rawUrl: string,
  policy: RendererUrlPolicy = getRendererUrlPolicy()
): boolean {
  return policy.isTrustedUrl(rawUrl)
}

export function assertTrustedIpcSender(
  event: Electron.IpcMainInvokeEvent
): void {
  const sender = event.sender
  const senderFrame = event.senderFrame
  if (!sender || !senderFrame || sender.isDestroyed()) {
    throw new Error('Blocked IPC call from an untrusted renderer')
  }

  const mainFrame = sender.mainFrame
  const owner = BrowserWindow.fromWebContents(sender)
  if (
    !owner ||
    owner.isDestroyed() ||
    owner.webContents !== sender ||
    !mainFrame ||
    senderFrame !== mainFrame ||
    sender.getURL() !== senderFrame.url ||
    !isTrustedRendererUrl(senderFrame.url)
  ) {
    throw new Error('Blocked IPC call from an untrusted renderer')
  }
}

export function registerTrustedIpcHandler(
  channel: string,
  listener: Parameters<typeof ipcMain.handle>[1]
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event)
    return listener(event, ...args)
  })
}
