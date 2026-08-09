import { vi } from 'vitest'
import type { Updater } from '../update-manager'

export interface FakeUpdater extends Updater {
  fire(event: string, ...args: unknown[]): void
}

export function createFakeUpdater(): FakeUpdater {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()

  const fake: FakeUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    channel: null,
    allowPrerelease: false,
    allowDowngrade: false,
    isUpdateSupported: vi.fn().mockResolvedValue(true),
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return fake
    },
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    fire(event: string, ...args: unknown[]) {
      for (const h of listeners.get(event) ?? []) h(...args)
    },
  }
  return fake
}
