import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PairNudge } from '@/background/pairNudge'
import { i18n } from '@/shared/i18n'

declare const browser: {
  storage: {
    local: {
      get: (k: string) => Promise<Record<string, unknown>>
      set: (i: Record<string, unknown>) => Promise<void>
    }
  }
}

beforeEach(() => {
  let backing: Record<string, unknown> = {}
  browser.storage.local.get = vi.fn(async (k: string) =>
    k in backing ? { [k]: backing[k] } : {}
  )
  browser.storage.local.set = vi.fn(async (i: Record<string, unknown>) => {
    backing = { ...backing, ...i }
  })
})

describe('PairNudge', () => {
  it('fires the first time and suppresses a second within the window', async () => {
    const notify = vi.fn()
    let now = 1_000_000
    const nudge = new PairNudge({ notify, now: () => now })
    await nudge.maybeNudge()
    await nudge.maybeNudge()
    expect(notify).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith({
      title: i18n.t('notify.pairNudgeTitle'),
      message: i18n.t('notify.pairNudgeBody'),
      severity: 'reminder',
      kind: 'connection.reminder',
    })
    now += 25 * 60 * 60 * 1000 // 25h later
    await nudge.maybeNudge()
    expect(notify).toHaveBeenCalledTimes(2)
  })
})
