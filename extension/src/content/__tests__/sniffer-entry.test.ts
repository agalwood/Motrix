import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SnifferHandle } from '@/content/mediaSniffer'

type SnifferWindow = Window & {
  __motrixSniffer?: SnifferHandle
}

const snifferWindow = window as SnifferWindow

afterEach(() => {
  snifferWindow.__motrixSniffer?.uninstall()
  delete snifferWindow.__motrixSniffer
  vi.restoreAllMocks()
})

describe('sniffer-entry reinjection', () => {
  it('re-harvests through the existing handle instead of stacking hooks', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { name: 'https://cdn.test/master.m3u8' },
    ] as unknown as PerformanceEntryList)
    const postMessage = vi.spyOn(window, 'postMessage')

    await import('@/content/sniffer-entry')
    const installedHandle = snifferWindow.__motrixSniffer
    expect(installedHandle).toBeDefined()
    expect(postMessage).toHaveBeenCalledOnce()
    expect(postMessage).toHaveBeenLastCalledWith(
      { source: 'motrix-sniffer', type: 'hello' },
      '*'
    )

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { source: 'motrix-sniffer-relay', type: 'ready' },
      })
    )
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'motrix-sniffer',
        type: 'media',
        items: expect.arrayContaining([
          expect.objectContaining({
            url: 'https://cdn.test/master.m3u8',
          }),
        ]),
      }),
      '*'
    )
    expect(postMessage).toHaveBeenLastCalledWith(
      { source: 'motrix-sniffer', type: 'ack' },
      '*'
    )

    postMessage.mockClear()
    vi.resetModules()
    await import('@/content/sniffer-entry')

    expect(snifferWindow.__motrixSniffer).toBe(installedHandle)
    expect(postMessage).toHaveBeenCalledOnce()
  })
})
