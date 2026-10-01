// @vitest-environment node
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchFfmpegAsset } from './ffmpeg-fetch-electron'

const electron = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('electron', () => ({ net: electron }))

class Request extends EventEmitter {
  abort = vi.fn(() => {
    this.emit('abort')
    this.emit('close')
  })
  end = vi.fn()
  followRedirect = vi.fn()
}
class Incoming extends EventEmitter {
  statusCode = 200
  headers: Record<string, string | string[]> = {
    'content-length': '3',
    'content-type': 'application/octet-stream',
  }
}
let request: Request
const url =
  'https://github.com/motrixapp/ffmpeg-static/releases/download/v9.0.2-motrix.8/ffmpeg-manifest.json'
function fetchAsset(signal?: AbortSignal) {
  return fetchFfmpegAsset(url, {
    redirect: 'manual',
    credentials: 'omit',
    signal,
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  request = new Request()
  electron.request.mockReturnValue(request)
})

describe('Electron FFmpeg manual-redirect transport', () => {
  it('exposes one redirect without following or sending cookies/authentication', async () => {
    const pending = fetchAsset()
    const destination =
      'https://release-assets.githubusercontent.com/asset?temporary=public'
    request.emit('redirect', 302, 'GET', destination, {})
    const response = await pending
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(destination)
    expect(response.body).toBeNull()
    expect(request.followRedirect).not.toHaveBeenCalled()
    expect(request.abort).toHaveBeenCalledOnce()
    expect(electron.request).toHaveBeenCalledWith({
      url,
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      useSessionCookies: false,
      bypassCustomProtocolHandlers: true,
      cache: 'no-store',
    })
    // Chromium emits cancellation after a manual redirect; it must not become unhandled.
    request.emit('error', new Error('Redirect cancelled'))
  })
  it('leaves an untrusted redirect visible to the core rather than requesting it', async () => {
    const pending = fetchAsset()
    request.emit('redirect', 302, 'GET', 'http://untrusted.invalid/payload', {})
    expect((await pending).headers.get('location')).toBe(
      'http://untrusted.invalid/payload'
    )
    expect(electron.request).toHaveBeenCalledOnce()
    expect(request.followRedirect).not.toHaveBeenCalled()
  })
  it('streams bytes and preserves content-length for the core size limit', async () => {
    const pending = fetchAsset()
    // Real Electron emits writable close before the valid response arrives.
    request.emit('close')
    const incoming = new Incoming()
    request.emit('response', incoming)
    const response = await pending
    const bytes = response.arrayBuffer()
    request.emit('close')
    incoming.emit('data', Buffer.from('abc'))
    incoming.emit('end')
    incoming.emit('close')
    request.emit('close')
    expect(Buffer.from(await bytes).toString()).toBe('abc')
    expect(response.headers.get('content-length')).toBe('3')
    expect(request.abort).not.toHaveBeenCalled()
  })
  it('cleans up when ending the native request throws', async () => {
    request.end.mockImplementation(() => {
      throw new Error('Native failure')
    })
    await expect(fetchAsset()).rejects.toThrow('FFmpeg network request failed')
    expect(request.abort).toHaveBeenCalledOnce()
    request.emit('error', new Error('Late error'))
  })
  it('does not create a request for an already aborted signal', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(fetchAsset(abort.signal)).rejects.toThrow()
    expect(electron.request).not.toHaveBeenCalled()
  })
  it('aborts during the body and rejects the pending reader without exposing remote errors', async () => {
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    const pending = fetchAsset(abort.signal)
    const incoming = new Incoming()
    request.emit('response', incoming)
    const reader = (await pending).body!.getReader()
    const reading = reader.read()
    abort.abort()
    await expect(reading).rejects.toThrow('FFmpeg network request failed')
    expect(request.abort).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(incoming.listenerCount('data')).toBe(0)
    expect(incoming.listenerCount('end')).toBe(0)
    expect(request.listenerCount('redirect')).toBe(0)
    incoming.emit('data', Buffer.from('late'))
    incoming.emit('error', new Error('Private remote diagnostic'))
  })
  it('cancels the request when the core cancels an oversize response', async () => {
    const pending = fetchAsset()
    const incoming = new Incoming()
    incoming.headers['content-length'] = String(256 * 1024 * 1024)
    request.emit('response', incoming)
    const response = await pending
    expect(response.headers.get('content-length')).toBe(
      String(256 * 1024 * 1024)
    )
    await response.body!.cancel()
    expect(request.abort).toHaveBeenCalledOnce()
    expect(incoming.listenerCount('data')).toBe(0)
  })
  it('rejects abort before response headers and removes the signal listener', async () => {
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    const pending = fetchAsset(abort.signal)
    abort.abort()
    await expect(pending).rejects.toThrow('FFmpeg network request failed')
    expect(request.abort).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    request.emit('error', new Error('Late error'))
  })
  it.each(['request', 'response', 'aborted', 'close'])(
    'rejects a pending reader after a late %s failure',
    async (source) => {
      const pending = fetchAsset()
      const incoming = new Incoming()
      request.emit('response', incoming)
      const reading = (await pending).body!.getReader().read()
      if (source === 'request') request.emit('error', new Error('Remote text'))
      else if (source === 'response')
        incoming.emit('error', new Error('Remote text'))
      else if (source === 'aborted') incoming.emit('aborted')
      else incoming.emit('close')
      await expect(reading).rejects.toThrow('FFmpeg network request failed')
      expect(request.abort).toHaveBeenCalledOnce()
    }
  )
  it('bounds queued bytes when the consumer is not reading', async () => {
    const pending = fetchAsset()
    const incoming = new Incoming()
    request.emit('response', incoming)
    const response = await pending
    incoming.emit('data', Buffer.alloc(8 * 1024 * 1024))
    incoming.emit('data', Buffer.from('over limit'))
    await expect(response.arrayBuffer()).rejects.toThrow(
      'FFmpeg network request failed'
    )
    expect(request.abort).toHaveBeenCalledOnce()
  })
  it.each([
    { method: 'POST' },
    { credentials: 'include' },
    { redirect: 'follow' },
    { body: 'payload' },
    { headers: { authorization: 'not-allowed' } },
  ])('rejects unsupported request options', async (extra) => {
    await expect(
      fetchFfmpegAsset(url, {
        redirect: 'manual',
        credentials: 'omit',
        ...extra,
      } as RequestInit)
    ).rejects.toThrow('Unsupported FFmpeg download request')
    expect(electron.request).not.toHaveBeenCalled()
  })
})
