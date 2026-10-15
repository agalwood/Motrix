import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getThemeOverride, setThemeOverride } from '@/shared/themeStore'

declare const browser: {
  storage: {
    local: {
      get: (k: string) => Promise<Record<string, unknown>>
      set: (i: Record<string, unknown>) => Promise<void>
      remove: (k: string) => Promise<void>
    }
  }
}

beforeEach(() => {
  let bag: Record<string, unknown> = {}
  browser.storage.local.get = vi.fn(async (k: string) =>
    k in bag ? { [k]: bag[k] } : {}
  )
  browser.storage.local.set = vi.fn(async (i: Record<string, unknown>) => {
    bag = { ...bag, ...i }
  })
  browser.storage.local.remove = vi.fn(async (k: string) => {
    delete bag[k]
  })
})

describe('themeStore', () => {
  it('defaults to null (follow system)', async () => {
    expect(await getThemeOverride()).toBeNull()
  })
  it('round-trips dark', async () => {
    await setThemeOverride('dark')
    expect(await getThemeOverride()).toBe('dark')
  })
  it('clears with null', async () => {
    await setThemeOverride('light')
    await setThemeOverride(null)
    expect(await getThemeOverride()).toBeNull()
  })
})
