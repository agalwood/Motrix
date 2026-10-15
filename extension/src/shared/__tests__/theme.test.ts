import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initTheme } from '@/shared/theme'

interface FakeMql {
  matches: boolean
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  emit: (matches: boolean) => void
}

function mockMatchMedia(initial: boolean): FakeMql {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql: FakeMql = {
    matches: initial,
    addEventListener: vi.fn((_t: string, l: (e: MediaQueryListEvent) => void) =>
      listeners.add(l)
    ),
    removeEventListener: vi.fn(
      (_t: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l)
    ),
    emit(matches: boolean) {
      mql.matches = matches
      for (const l of listeners) l({ matches } as MediaQueryListEvent)
    },
  }
  ;(window as unknown as { matchMedia: unknown }).matchMedia = vi.fn(() => mql)
  return mql
}

declare const browser: {
  storage: {
    local: { get: (k: string) => Promise<Record<string, unknown>> }
    onChanged: {
      addListener: ReturnType<typeof vi.fn>
      removeListener: ReturnType<typeof vi.fn>
    }
  }
}

beforeEach(() => {
  browser.storage.local.get = vi.fn(async () => ({}))
  browser.storage.onChanged = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }
})

afterEach(() => {
  document.documentElement.classList.remove('dark')
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
})

describe('initTheme', () => {
  it('follows system dark when no override stored', async () => {
    mockMatchMedia(true)
    initTheme()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('removes stale .dark when system prefers light and no override', () => {
    document.documentElement.classList.add('dark')
    mockMatchMedia(false)
    initTheme()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('forces dark when override=dark even if system is light', async () => {
    browser.storage.local.get = vi.fn(async () => ({ 'motrix.theme': 'dark' }))
    mockMatchMedia(false)
    initTheme()
    await vi.waitFor(() =>
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    )
  })

  it('reacts live to OS change when following system', () => {
    const mql = mockMatchMedia(false)
    initTheme()
    mql.emit(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    mql.emit(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('detaches listeners on teardown', () => {
    const mql = mockMatchMedia(true)
    const stop = initTheme()
    stop()
    expect(mql.removeEventListener).toHaveBeenCalledOnce()
    expect(browser.storage.onChanged.removeListener).toHaveBeenCalledOnce()
  })

  it('no-ops gracefully when matchMedia is unavailable', () => {
    expect(() => initTheme()).not.toThrow()
  })
})
