import { describe, expect, it, vi } from 'vitest'
import { fetchManifest } from './manifest-fetcher'

describe('fetchManifest', () => {
  it('rejects a malformed redirect before following it', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://other.test/a\\b' },
        })
    )
    await expect(
      fetchManifest('https://example.test/list', { fetchImpl })
    ).rejects.toMatchObject({ code: 'TASK_SOURCE_INVALID' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('drops credentials on a cross-origin redirect and excludes fragments', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.test/list#view' },
        })
      )
      .mockResolvedValueOnce(new Response('#EXTM3U'))
    await fetchManifest('https://example.test/list', {
      fetchImpl,
      headers: { Authorization: 'secret', Cookie: 'sid=secret', Accept: '*/*' },
    })
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://cdn.test/list',
      expect.objectContaining({
        redirect: 'manual',
        headers: { Accept: '*/*' },
      })
    )
  })

  it('limits the streamed UTF-8 byte count', async () => {
    await expect(
      fetchManifest('https://example.test/list', {
        fetchImpl: vi.fn(async () => new Response('中文')),
        maxBytes: 4,
      })
    ).rejects.toThrow('manifest too large')
  })
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
