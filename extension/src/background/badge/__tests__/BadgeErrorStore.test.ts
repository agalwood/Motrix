import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BadgeErrorStore } from '@/background/badge/BadgeErrorStore'

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

describe('BadgeErrorStore', () => {
  it('defaults to false when nothing stored', async () => {
    expect(await new BadgeErrorStore().get()).toBe(false)
  })
  it('round-trips true/false', async () => {
    const s = new BadgeErrorStore()
    await s.set(true)
    expect(await s.get()).toBe(true)
    await s.set(false)
    expect(await s.get()).toBe(false)
  })
  it('falls back to false on a non-boolean stored value', async () => {
    await browser.storage.local.set({ 'motrix.badgeError': 'garbage' })
    expect(await new BadgeErrorStore().get()).toBe(false)
  })
})
