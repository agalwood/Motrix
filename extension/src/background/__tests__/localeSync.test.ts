import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLocaleChangeHandler } from '@/background/localeSync'
import { i18n } from '@/shared/i18n'

declare const browser: {
  storage: {
    local: {
      get: (k: string) => Promise<Record<string, unknown>>
      set: (i: Record<string, unknown>) => Promise<void>
      remove: (k: string) => Promise<void>
    }
  }
  i18n: {
    getUILanguage: () => string
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

afterEach(async () => {
  await i18n.changeLanguage('en-US')
})

describe('makeLocaleChangeHandler', () => {
  it('ignores changes in non-local areas', async () => {
    const onApplied = vi.fn()
    const handler = makeLocaleChangeHandler(onApplied)
    handler({ 'motrix.locale': { newValue: 'zh-CN' } }, 'sync')
    await Promise.resolve()
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('ignores local changes without the locale key', async () => {
    const onApplied = vi.fn()
    const handler = makeLocaleChangeHandler(onApplied)
    handler({ 'some.other.key': { newValue: 'whatever' } }, 'local')
    await Promise.resolve()
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('applies locale change and calls onApplied when motrix.locale changes in local storage', async () => {
    const onApplied = vi.fn()
    const handler = makeLocaleChangeHandler(onApplied)

    // Set the storage to return zh-CN for the locale key
    browser.storage.local.set({ 'motrix.locale': 'zh-CN' })

    handler({ 'motrix.locale': { newValue: 'zh-CN' } }, 'local')

    await vi.waitFor(() => {
      expect(onApplied).toHaveBeenCalledOnce()
    })

    expect(i18n.language).toBe('zh-CN')
    expect(onApplied).toHaveBeenCalledOnce()
  })
})
