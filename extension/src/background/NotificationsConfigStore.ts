import { extensionBrowser as browser } from '@/shared/browser'
import { getBuildBrowser } from '@/shared/browserKind'
import {
  NOTIFICATIONS_DEFAULT,
  type NotificationsConfig,
} from '@/shared/notifications'

const STORAGE_KEY = 'motrix.notificationsConfig'

export class NotificationsConfigStore {
  async get(): Promise<NotificationsConfig> {
    const obj = await browser.storage.local.get(STORAGE_KEY)
    const v = (obj as Record<string, unknown>)[STORAGE_KEY]
    const safari = getBuildBrowser() === 'safari'
    const defaults = {
      ...NOTIFICATIONS_DEFAULT,
      ...(safari ? { master: false } : {}),
    }
    if (!v || typeof v !== 'object') return defaults
    const c = v as Partial<NotificationsConfig> & {
      safariNativeOptIn?: boolean
    }
    if (
      typeof c.master !== 'boolean' ||
      typeof c.confirm !== 'boolean' ||
      typeof c.error !== 'boolean' ||
      typeof c.reminder !== 'boolean'
    ) {
      return defaults
    }
    return {
      master: c.master && (!safari || c.safariNativeOptIn === true),
      confirm: c.confirm,
      error: c.error,
      reminder: c.reminder,
    }
  }

  async set(config: NotificationsConfig): Promise<void> {
    await browser.storage.local.set({
      [STORAGE_KEY]: {
        ...config,
        ...(getBuildBrowser() === 'safari' ? { safariNativeOptIn: true } : {}),
      },
    })
  }
}
