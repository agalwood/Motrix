import { describe, expect, it, vi } from 'vitest'
import { fetchManifest } from './manifest-fetcher'

describe('fetchManifest', () => {
  it('GETs with replayed headers and returns text', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('#EXTM3U', { status: 200 })
    )
    const text = await fetchManifest('https://h.example/m.m3u8', {
      headers: { Referer: 'https://h.example/p' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(text).toBe('#EXTM3U')
    expect(fetchImpl.mock.calls.length).toBe(1)
    const init = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect((init[1].headers as Record<string, string>).Referer).toBe(
      'https://h.example/p'
    )
  })

  it('throws with the status on non-2xx', async () => {
    const cancel = vi.fn()
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('no'))
            },
            cancel,
          }),
          { status: 403 }
        )
    )
    await expect(
      fetchManifest('https://h.example/m.m3u8', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(/403/)
    expect(cancel).toHaveBeenCalledOnce()
  })
})
