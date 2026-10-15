import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Browser } from '@/shared/browser'

const globals = globalThis as unknown as {
  browser?: typeof Browser
  chrome: typeof Browser
}
const originalBrowser = globals.browser
const originalChrome = globals.chrome

afterEach(() => {
  globals.browser = originalBrowser
  globals.chrome = originalChrome
  vi.resetModules()
})

describe('browser API compatibility boundary', () => {
  it('adapts callback-only Chromium APIs without installing a browser global', async () => {
    Reflect.deleteProperty(globals, 'browser')
    const get = vi.fn((_key, callback) => callback({ theme: 'dark' }))
    globals.chrome = {
      ...originalChrome,
      storage: { local: { get } },
    } as unknown as typeof Browser
    vi.resetModules()

    const { extensionBrowser, nativeBrowser } = await import('@/shared/browser')
    const { resolveDefaultLocale } = await import('@/shared/i18n')

    await expect(extensionBrowser.storage.local.get('theme')).resolves.toEqual({
      theme: 'dark',
    })
    expect(get).toHaveBeenCalledWith('theme', expect.any(Function))
    expect(nativeBrowser).toBe(globals.chrome)
    expect(globals.browser).toBeUndefined()
    expect(resolveDefaultLocale()).toBe('en-US')
  })

  it('preserves the native API and callback-sensitive events on modern Chromium', async () => {
    const event = { addListener: vi.fn() }
    globals.chrome = {
      ...originalChrome,
      downloads: { onDeterminingFilename: event },
    } as unknown as typeof Browser
    globals.browser = globals.chrome
    vi.resetModules()

    const { extensionBrowser, nativeBrowser } = await import('@/shared/browser')
    expect(extensionBrowser).toBe(globals.browser)
    expect(nativeBrowser.downloads.onDeterminingFilename).toBe(event)
  })

  it('preserves Firefox Promises when callback-only chrome APIs also exist', async () => {
    const get = vi.fn(async () => ({ theme: 'dark' }))
    const chromeGet = vi.fn(() => {
      throw new Error('must use Firefox browser API')
    })
    globals.browser = {
      ...originalBrowser,
      storage: { local: { get } },
    } as unknown as typeof Browser
    globals.chrome = {
      ...originalChrome,
      storage: { local: { get: chromeGet } },
    } as unknown as typeof Browser
    vi.resetModules()

    const { extensionBrowser } = await import('@/shared/browser')
    expect(extensionBrowser).toBe(globals.browser)
    await expect(extensionBrowser.storage.local.get('theme')).resolves.toEqual({
      theme: 'dark',
    })
    expect(get).toHaveBeenCalledWith('theme')
    expect(chromeGet).not.toHaveBeenCalled()
  })
})
