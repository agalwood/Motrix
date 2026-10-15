import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationsConfigStore } from '@/background/NotificationsConfigStore'
import { NOTIFICATIONS_DEFAULT } from '@/shared/notifications'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
    }
  }
}

beforeEach(() => {
  let backing: Record<string, unknown> = {}
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    const key = Array.isArray(k) ? k[0] : k
    return key && key in backing ? { [key]: backing[key] } : {}
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
})

describe('NotificationsConfigStore', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('requires an explicit Safari preference before enabling existing default notifications', async () => {
    vi.stubGlobal('__BROWSER__', 'safari')
    const store = new NotificationsConfigStore()
    expect((await store.get()).master).toBe(false)
    await browser.storage.local.set({
      'motrix.notificationsConfig': NOTIFICATIONS_DEFAULT,
    })
    expect((await store.get()).master).toBe(false)
    await store.set(NOTIFICATIONS_DEFAULT)
    expect((await store.get()).master).toBe(true)
    await store.set({ ...NOTIFICATIONS_DEFAULT, master: false })
    expect((await store.get()).master).toBe(false)
  })
  it('returns the default when nothing is stored', async () => {
    expect(await new NotificationsConfigStore().get()).toEqual(
      NOTIFICATIONS_DEFAULT
    )
  })

  it('round-trips a saved config', async () => {
    const store = new NotificationsConfigStore()
    const cfg = { master: true, confirm: true, error: false, reminder: true }
    await store.set(cfg)
    expect(await store.get()).toEqual(cfg)
  })

  it('falls back to the default on a malformed stored value', async () => {
    await browser.storage.local.set({ 'motrix.notificationsConfig': 'garbage' })
    expect(await new NotificationsConfigStore().get()).toEqual(
      NOTIFICATIONS_DEFAULT
    )
  })

  it('falls back to the default when a key is missing or non-boolean', async () => {
    await browser.storage.local.set({
      'motrix.notificationsConfig': {
        master: true,
        confirm: 'yes',
        error: true,
        reminder: true,
      },
    })
    expect(await new NotificationsConfigStore().get()).toEqual(
      NOTIFICATIONS_DEFAULT
    )
  })
})
