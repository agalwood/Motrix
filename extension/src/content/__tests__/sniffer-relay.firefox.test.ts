import { afterEach, describe, expect, it, vi } from 'vitest'

type FirefoxRelayWindow = Window & {
  __motrixSnifferRelayInstalled?: boolean
  __motrixSnifferRelayAnnounce?: () => void
  __motrixSnifferIsolatedFallback?: { uninstall: () => void }
}

const relayWindow = window as FirefoxRelayWindow

afterEach(() => {
  relayWindow.__motrixSnifferIsolatedFallback?.uninstall()
  delete relayWindow.__motrixSnifferIsolatedFallback
  delete relayWindow.__motrixSnifferRelayInstalled
  delete relayWindow.__motrixSnifferRelayAnnounce
  delete (globalThis as { __BROWSER__?: string }).__BROWSER__
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('sniffer-relay Firefox parity', () => {
  it('activates an isolated fallback only when the MAIN handshake never arrives', async () => {
    vi.useFakeTimers()
    ;(globalThis as { __BROWSER__?: string }).__BROWSER__ = 'firefox'
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
      [] as unknown as PerformanceEntryList
    )
    const firefoxSend = vi.fn(async () => undefined)
    ;(
      globalThis as unknown as {
        browser: { runtime: { sendMessage: typeof firefoxSend } }
      }
    ).browser.runtime.sendMessage = firefoxSend

    const originalFetch = window.fetch
    await import('@/content/sniffer-relay')

    await vi.advanceTimersByTimeAsync(499)
    expect(window.fetch).toBe(originalFetch)
    await vi.advanceTimersByTimeAsync(1)
    expect(window.fetch).not.toBe(originalFetch)

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { source: 'motrix-sniffer', type: 'hello' },
      })
    )
    expect(window.fetch).toBe(originalFetch)

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          source: 'motrix-sniffer',
          type: 'media',
          items: [
            {
              kind: 'direct',
              url: 'https://cdn.example/firefox.mp4',
              pageUrl: 'https://page.example/',
              pageTitle: 'Firefox page',
              detectedAt: 1,
            },
          ],
        },
      })
    )
    await Promise.resolve()
    expect(firefoxSend).toHaveBeenCalledOnce()
  })
})
