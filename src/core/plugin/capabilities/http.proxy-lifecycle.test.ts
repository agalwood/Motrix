import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  sharedDestroy: vi.fn(async () => undefined),
  proxyAgents: [] as Array<{
    options: unknown
    destroy: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('undici', () => ({
  Agent: class MockAgent {
    destroy = mocks.sharedDestroy
  },
  ProxyAgent: class MockProxyAgent {
    readonly destroy = vi.fn(async () => undefined)

    constructor(readonly options: unknown) {
      mocks.proxyAgents.push(this)
    }
  },
  request: (...args: unknown[]) => mocks.request(...args),
}))

const { HttpCapabilityHost } = await import('./http')

function response(body: Readable = Readable.from(Buffer.from('ok'))) {
  return { statusCode: 200, headers: {}, body }
}

beforeEach(() => {
  mocks.request.mockReset()
  mocks.sharedDestroy.mockClear()
  mocks.proxyAgents.splice(0)
})

describe('HttpCapabilityHost proxy lifecycle', () => {
  it('destroys an owned HTTP ProxyAgent after a successful response', async () => {
    mocks.request.mockResolvedValueOnce(response())

    const result = await new HttpCapabilityHost().get(
      'https://downloads.example/file',
      { proxy: 'http://127.0.0.1:8080' }
    )

    expect(result.body).toBe('ok')
    expect(mocks.proxyAgents).toHaveLength(1)
    expect(mocks.request.mock.calls[0]?.[1]).toMatchObject({
      dispatcher: mocks.proxyAgents[0],
    })
    expect(mocks.proxyAgents[0]?.destroy).toHaveBeenCalledOnce()
    expect(mocks.sharedDestroy).not.toHaveBeenCalled()
  })

  it('destroys an owned HTTP ProxyAgent when the request rejects', async () => {
    mocks.request.mockRejectedValueOnce(new Error('connect failed'))

    await expect(
      new HttpCapabilityHost().get('https://downloads.example/file', {
        proxy: 'https://127.0.0.1:8443',
      })
    ).rejects.toMatchObject({ code: 'plugin.http.network' })

    expect(mocks.proxyAgents).toHaveLength(1)
    expect(mocks.proxyAgents[0]?.destroy).toHaveBeenCalledOnce()
  })

  it('does not allocate a ProxyAgent for an already-aborted request', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      new HttpCapabilityHost().get('https://downloads.example/file', {
        proxy: 'http://127.0.0.1:8080',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'plugin.http.aborted' })

    expect(mocks.proxyAgents).toHaveLength(0)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('fails closed for SOCKS proxies before opening a connection', async () => {
    await expect(
      new HttpCapabilityHost().get('https://downloads.example/file', {
        proxy: 'socks5://127.0.0.1:1080',
      })
    ).rejects.toMatchObject({
      code: 'plugin.http.proxy_scheme_not_supported',
    })

    expect(mocks.proxyAgents).toHaveLength(0)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('cancels a stalled response body and reports a body-phase timeout', async () => {
    let body: Readable | undefined
    mocks.request.mockImplementationOnce(
      async (_url: unknown, options: { signal: AbortSignal }) => {
        body = Readable.from(
          (async function* () {
            yield Buffer.from('partial')
            await new Promise<void>((_resolve, reject) => {
              options.signal.addEventListener(
                'abort',
                () => reject(new Error('body aborted')),
                { once: true }
              )
            })
          })()
        )
        return response(body)
      }
    )

    await expect(
      new HttpCapabilityHost({ defaultTimeoutMs: 10 }).get(
        'https://downloads.example/file',
        { proxy: 'http://127.0.0.1:8080' }
      )
    ).rejects.toMatchObject({ code: 'plugin.http.timeout' })

    expect(body?.destroyed).toBe(true)
    expect(mocks.proxyAgents[0]?.destroy).toHaveBeenCalledOnce()
  })

  it('installs an error listener before destroying an unread response', async () => {
    const order: string[] = []
    const body = {
      once: vi.fn((event: string) => {
        order.push(`once:${event}`)
      }),
      destroy: vi.fn(() => {
        order.push('destroy')
      }),
    }
    mocks.request.mockResolvedValueOnce({
      statusCode: 302,
      headers: { location: 'https://downloads.example/redirected' },
      body,
    })

    await expect(
      new HttpCapabilityHost().get('https://downloads.example/file', {
        proxy: 'http://127.0.0.1:8080',
        redirect: 'error',
      })
    ).rejects.toMatchObject({ code: 'plugin.http.redirect_not_allowed' })

    expect(order.slice(0, 2)).toEqual(['once:error', 'destroy'])
    expect(mocks.proxyAgents[0]?.destroy).toHaveBeenCalledOnce()
  })
})
