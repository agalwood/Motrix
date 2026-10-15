import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNotify } from '@/background/notify'
import type { NotificationsConfig } from '@/shared/notifications'

declare const browser: {
  runtime: { getURL: (p: string) => string }
  notifications: { create: (o: unknown) => Promise<string> }
}

function storeOf(cfg: NotificationsConfig): {
  get: () => Promise<NotificationsConfig>
} {
  return { get: vi.fn(async () => cfg) }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  browser.runtime = { getURL: (p: string) => `chrome-extension://abc/${p}` }
  browser.notifications = { create: vi.fn(async () => 'id') }
})

describe('createNotify (severity gate)', () => {
  it('fires when master + severity are enabled, with a non-empty iconUrl', async () => {
    const notify = createNotify(
      storeOf({ master: true, confirm: true, error: true, reminder: true })
    )
    notify({ title: 'T', message: 'M', severity: 'confirm' })
    await flush()
    expect(browser.notifications.create).toHaveBeenCalledTimes(1)
    const arg = (browser.notifications.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as {
      type: string
      iconUrl: string
      title: string
      message: string
    }
    expect(arg.type).toBe('basic')
    expect(arg.iconUrl).toMatch(/icons\/icon-128\.png$/)
    expect(arg.title).toBe('T')
    expect(arg.message).toBe('M')
  })

  it('master off suppresses every severity', async () => {
    const notify = createNotify(
      storeOf({ master: false, confirm: true, error: true, reminder: true })
    )
    notify({ title: 'T', message: 'M', severity: 'error' })
    await flush()
    expect(browser.notifications.create).not.toHaveBeenCalled()
  })

  it('master on but the severity bucket off suppresses that severity', async () => {
    const notify = createNotify(
      storeOf({ master: true, confirm: false, error: true, reminder: true })
    )
    notify({ title: 'T', message: 'M', severity: 'confirm' })
    await flush()
    expect(browser.notifications.create).not.toHaveBeenCalled()
  })
})
