import { describe, expect, it } from 'vitest'

declare const chrome: {
  storage: { local: { get: (k: string) => Promise<Record<string, unknown>> } }
  runtime: { connectNative: (...a: unknown[]) => unknown }
}

declare const browser: typeof chrome

describe('test setup', () => {
  it('browser global is defined', () => {
    expect(browser).toBeDefined()
    expect(browser.runtime.connectNative).toBeDefined()
  })

  it('chrome global mirrors browser (cross-browser stub)', () => {
    expect(chrome).toBeDefined()
    expect(chrome.runtime.connectNative).toBe(browser.runtime.connectNative)
  })

  it('browser.storage.local.get works as mock', async () => {
    const result = await browser.storage.local.get('any')
    expect(result).toEqual({})
  })

  it('provides the layout API used by input-otp', () => {
    expect(document.elementFromPoint).toBeTypeOf('function')
  })
})
