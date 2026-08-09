import { EventEmitter } from 'node:events'
import { ErrorCode } from '@shared/errors'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}))

vi.mock('node:http', () => ({
  default: { request: requestMock },
}))

import { HTTP_MAX_RESPONSE_SIZE, NodeHttpClient } from './http-client'

class FakeRequest extends EventEmitter {
  destroyed = false
  endedWith: string | undefined
  timeoutMs: number | undefined
  timeoutHandler: (() => void) | undefined

  setTimeout(timeoutMs: number, handler: () => void): this {
    this.timeoutMs = timeoutMs
    this.timeoutHandler = handler
    return this
  }

  destroy(): this {
    this.destroyed = true
    return this
  }

  end(body?: string): void {
    this.endedWith = body
  }
}

class FakeResponse extends EventEmitter {
  destroyed = false

  constructor(
    public statusCode: number,
    public headers: Record<string, string | string[] | undefined> = {}
  ) {
    super()
  }

  destroy(): this {
    this.destroyed = true
    return this
  }
}

function primeRequest() {
  const request = new FakeRequest()
  let options: Record<string, unknown> | undefined
  let responseHandler: ((response: FakeResponse) => void) | undefined

  requestMock.mockImplementationOnce(
    (
      nextOptions: Record<string, unknown>,
      handler: (response: FakeResponse) => void
    ) => {
      options = nextOptions
      responseHandler = handler
      return request
    }
  )

  return {
    request,
    get options() {
      return options
    },
    respond(response: FakeResponse) {
      responseHandler?.(response)
    },
  }
}

describe('NodeHttpClient', () => {
  beforeEach(() => {
    requestMock.mockReset()
  })

  it.each([
    ['router.local', 'host must be literal IPv4'],
    ['8.8.8.8', 'host must be private or link-local IPv4'],
  ])('rejects unsafe host %s before opening a socket', async (host, detail) => {
    const result = await new NodeHttpClient().request({
      method: 'GET',
      host,
      port: 80,
      path: '/',
    })

    expect(result).toEqual({
      ok: false,
      error: ErrorCode.NatSecurityViolation,
      detail,
    })
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('sends a bounded private-IP request and normalizes the response', async () => {
    const pendingRequest = primeRequest()
    const resultPromise = new NodeHttpClient().request({
      method: 'POST',
      host: '192.168.1.1',
      port: 49152,
      path: '/control',
      headers: { 'Content-Type': 'text/xml' },
      body: '<soap/>',
      timeoutMs: 1234,
    })

    expect(pendingRequest.options).toEqual({
      method: 'POST',
      host: '192.168.1.1',
      port: 49152,
      path: '/control',
      headers: { 'Content-Type': 'text/xml' },
      family: 4,
    })
    expect(pendingRequest.request.timeoutMs).toBe(1234)
    expect(pendingRequest.request.endedWith).toBe('<soap/>')

    const response = new FakeResponse(200, {
      'x-router': 'gateway',
      'set-cookie': ['a=1', 'b=2'],
      empty: undefined,
    })
    pendingRequest.respond(response)
    response.emit('data', Buffer.from('hello '))
    response.emit('data', Buffer.from('world'))
    response.emit('end')

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      value: {
        statusCode: 200,
        headers: {
          'x-router': 'gateway',
          'set-cookie': 'a=1,b=2',
          empty: '',
        },
        body: 'hello world',
      },
    })
  })

  it('rejects redirects without following them', async () => {
    const pendingRequest = primeRequest()
    const resultPromise = new NodeHttpClient().request({
      method: 'GET',
      host: '169.254.10.20',
      port: 80,
      path: '/description.xml',
    })
    const response = new FakeResponse(302, {
      location: 'http://example.com/',
    })

    pendingRequest.respond(response)

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: ErrorCode.NatSecurityViolation,
      detail: 'unexpected redirect: 302',
    })
    expect(response.destroyed).toBe(true)
  })

  it('rejects responses above the hard size cap', async () => {
    const pendingRequest = primeRequest()
    const resultPromise = new NodeHttpClient().request({
      method: 'GET',
      host: '10.0.0.1',
      port: 80,
      path: '/',
    })
    const response = new FakeResponse(200)

    pendingRequest.respond(response)
    response.emit('data', Buffer.alloc(HTTP_MAX_RESPONSE_SIZE + 1))

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: ErrorCode.NatSecurityViolation,
      detail: 'http response too large',
    })
    expect(response.destroyed).toBe(true)
  })

  it('maps response stream errors to parse errors', async () => {
    const pendingRequest = primeRequest()
    const resultPromise = new NodeHttpClient().request({
      method: 'GET',
      host: '172.16.0.1',
      port: 80,
      path: '/',
    })
    const response = new FakeResponse(200)

    pendingRequest.respond(response)
    response.emit('error', new Error('truncated'))

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: ErrorCode.NatParseError,
      detail: 'truncated',
    })
  })

  it('maps request errors and timeouts to stable NAT errors', async () => {
    const failedRequest = primeRequest()
    const failedResult = new NodeHttpClient().request({
      method: 'GET',
      host: '192.168.0.1',
      port: 80,
      path: '/',
    })
    failedRequest.request.emit('error', new Error('connection refused'))

    await expect(failedResult).resolves.toEqual({
      ok: false,
      error: ErrorCode.NatGatewayUnreachable,
      detail: 'connection refused',
    })

    const timedOutRequest = primeRequest()
    const timedOutResult = new NodeHttpClient().request({
      method: 'GET',
      host: '192.168.0.1',
      port: 80,
      path: '/',
      timeoutMs: 50,
    })
    timedOutRequest.request.timeoutHandler?.()

    await expect(timedOutResult).resolves.toEqual({
      ok: false,
      error: ErrorCode.NatTimeout,
      detail: 'http timeout after 50ms',
    })
    expect(timedOutRequest.request.destroyed).toBe(true)
  })

  it('honors an already-aborted signal without writing a request body', async () => {
    const pendingRequest = primeRequest()
    const controller = new AbortController()
    controller.abort()

    const result = await new NodeHttpClient().request({
      method: 'POST',
      host: '192.168.0.1',
      port: 80,
      path: '/',
      body: 'must-not-send',
      signal: controller.signal,
    })

    expect(result).toEqual({
      ok: false,
      error: ErrorCode.NatTimeout,
      detail: 'aborted',
    })
    expect(pendingRequest.request.destroyed).toBe(true)
    expect(pendingRequest.request.endedWith).toBeUndefined()
  })
})
