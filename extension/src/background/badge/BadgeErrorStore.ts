import { extensionBrowser as browser } from '@/shared/browser'

const STORAGE_KEY = 'motrix.badgeError'

export class BadgeErrorStore {
  async get(): Promise<boolean> {
    const obj = await browser.storage.local.get(STORAGE_KEY)
    const v = (obj as Record<string, unknown>)[STORAGE_KEY]
    return typeof v === 'boolean' ? v : false
  }

  async set(v: boolean): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEY]: v })
  }
}
