import type { BridgeConnection } from '@core/bridge/bridge-connection'
import { UrlResolutionService } from '@core/bridge/url-resolution-service'
import { describe, expect, it } from 'vitest'
import { type CancellationToken, CancellationTokenSource } from 'vscode-jsonrpc'

describe('UrlResolutionService', () => {
  it('probes session, then resolves if handled=true', async () => {
    const conn = makeFakeConn({
      'url/probe': () => ({
        handled: true,
        adapterId: 'youtube',
        confidence: 'high',
      }),
      'url/resolve': () => ({
        selections: [
          {
            kind: 'direct',
            primary: {
              url: 'https://cdn.example.com/v.mp4',
              headers: {},
              cookies: [],
              refererPolicy: 'strict-origin-when-cross-origin',
            },
            container: 'mp4',
            quality: '720p',
          },
        ],
        meta: { title: 'X' },
        extractedBy: {
          adapterId: 'youtube',
          adapterVersion: '1.0',
          extractedAt: 0,
        },
      }),
    })
    const svc = new UrlResolutionService(() => [conn])

    const result = await svc.resolve('https://www.youtube.com/watch?v=abc', {})

    expect(result.selections).toHaveLength(1)
    expect(result.extractedBy.adapterId).toBe('youtube')
  })

  it('returns NotHandled if no session probes handled=true', async () => {
    const conn = makeFakeConn({
      'url/probe': () => ({ handled: false }),
    })
    const svc = new UrlResolutionService(() => [conn])

    await expect(svc.resolve('https://random.example.com', {})).rejects.toThrow(
      /no adapter/i
    )
  })

  it('returns NoSession if no sessions are active', async () => {
    const svc = new UrlResolutionService(() => [])
    await expect(svc.resolve('https://example.com', {})).rejects.toThrow(
      /no extension session/i
    )
  })

  it('propagates ext errors with appCode', async () => {
    const conn = makeFakeConn({
      'url/probe': () => ({ handled: true, adapterId: 'youtube' }),
      'url/resolve': () => {
        throw {
          code: -32001,
          message: 'video unavailable',
          data: { appCode: 'youtube.video_unavailable' },
        }
      },
    })
    const svc = new UrlResolutionService(() => [conn])

    await expect(
      svc.resolve('https://www.youtube.com/watch?v=x', {})
    ).rejects.toMatchObject({
      data: { appCode: 'youtube.video_unavailable' },
    })
  })
  it('forwards cancellation token to ext', async () => {
    let observed = false
    const conn = {
      sendRequest: async (
        method: string,
        _params: unknown,
        token: CancellationToken
      ) => {
        if (method === 'url/probe') return { handled: true, adapterId: 'x' }
        // url/resolve: wait so the cancel fires before we read the token
        await new Promise((r) => setTimeout(r, 30))
        observed = token.isCancellationRequested
        return {
          selections: [],
          meta: { title: '' },
          extractedBy: { adapterId: 'x', adapterVersion: '1', extractedAt: 0 },
        }
      },
    } as unknown as BridgeConnection
    const svc = new UrlResolutionService(() => [conn])
    const cts = new CancellationTokenSource()
    const p = svc.resolve('https://x.com', {}, cts.token)
    setTimeout(() => cts.cancel(), 5)
    await p.catch(() => undefined)
    expect(observed).toBe(true)
  })
})

function makeFakeConn(handlers: Record<string, (params: unknown) => unknown>) {
  return {
    sendRequest: async (method: string, params: unknown) => {
      const h = handlers[method]
      if (!h) throw new Error(`no handler for ${method}`)
      return h(params)
    },
  } as unknown as BridgeConnection
}
