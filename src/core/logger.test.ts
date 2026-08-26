import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getLogger, initLogger } from './logger'

describe('logger', () => {
  beforeEach(() => {
    initLogger(pino({ level: 'silent' }))
  })

  it('initLogger replaces the root logger', () => {
    const mockInfo = vi.fn()
    const mockChild = vi.fn().mockReturnValue({ info: mockInfo })
    const fakeLogger = { child: mockChild } as never

    initLogger(fakeLogger)

    const log = getLogger('test-module')
    log.info('hello')

    expect(mockChild).toHaveBeenCalledWith({ module: 'test-module' })
    expect(mockInfo).toHaveBeenCalledWith('hello')
  })

  it('redacts structured fields before forwarding to the root logger', () => {
    const mockInfo = vi.fn()
    const mockChild = vi.fn().mockReturnValue({ info: mockInfo })
    initLogger({ child: mockChild } as never)

    getLogger('downloads').info(
      {
        url: 'https://example.com/file?token=secret',
        headers: { Authorization: 'Bearer secret' },
        proxy: 'http://user:secret@proxy.example:8080',
        connections: 16,
      },
      'dispatching'
    )

    expect(mockInfo).toHaveBeenCalledWith(
      {
        url: 'https://example.com/file',
        headers: ['Authorization'],
        proxy: 'http://proxy.example:8080',
        connections: 16,
      },
      'dispatching'
    )
  })

  it('preserves Pino string and formatting overloads', () => {
    const mockInfo = vi.fn()
    initLogger({ child: vi.fn().mockReturnValue({ info: mockInfo }) } as never)

    getLogger('format').info('created %s', 'task-1')

    expect(mockInfo).toHaveBeenCalledWith('created %s', 'task-1')
  })

  it('redacts objects used by Pino formatting overloads', () => {
    const mockInfo = vi.fn()
    initLogger({ child: vi.fn().mockReturnValue({ info: mockInfo }) } as never)

    getLogger('format').info('request %j', {
      token: 'format-secret',
      url: 'https://example.com/file?signature=format-url-secret',
      count: 1,
    })

    expect(mockInfo).toHaveBeenCalledWith('request %j', {
      token: '[redacted]',
      url: 'https://example.com/file',
      count: 1,
    })
  })

  it('redacts direct Error properties while retaining Error diagnostics', () => {
    const mockError = vi.fn()
    initLogger({
      child: vi.fn().mockReturnValue({ error: mockError }),
    } as never)
    const error = Object.assign(new Error('request failed'), {
      code: 'ECONNRESET',
      token: 'direct-error-secret',
    })

    getLogger('requests').error(error, 'direct error')

    const forwarded = mockError.mock.calls[0]?.[0] as Error &
      Record<string, unknown>
    expect(forwarded).toBeInstanceOf(Error)
    expect(forwarded.message).toBe('request failed')
    expect(forwarded.stack).toContain('request failed')
    expect(forwarded.code).toBe('ECONNRESET')
    expect(forwarded.token).toBe('[redacted]')
    expect(mockError.mock.calls[0]?.[1]).toBe('direct error')
  })

  it('protects custom Pino level methods', () => {
    const mockNotice = vi.fn()
    const rootChild = {
      levels: { values: { notice: 35 } },
      notice: mockNotice,
    }
    initLogger({ child: vi.fn().mockReturnValue(rootChild) } as never)

    const log = getLogger('custom-level') as unknown as {
      notice(fields: Record<string, unknown>, message: string): void
    }
    log.notice({ authorization: 'Bearer secret', count: 1 }, 'notice')

    expect(mockNotice).toHaveBeenCalledWith(
      { authorization: '[redacted]', count: 1 },
      'notice'
    )
  })

  it('preserves integrity and redaction in serialized Pino output', () => {
    const chunks: string[] = []
    const destination: pino.DestinationStream = {
      write(chunk: string) {
        chunks.push(chunk)
      },
    }
    initLogger(pino({ level: 'trace' }, destination))
    const log = getLogger('serialized')

    log.info(
      {
        level: 99,
        time: 0,
        msg: 'forged',
        module: 'forged-module',
        name: 'diagnostic-name',
        timestamp: 123,
        ts: 456,
        token: 'field-secret',
      },
      'actual message'
    )
    log.error(
      Object.assign(new Error('direct failure'), {
        token: 'error-secret',
      }),
      'error message'
    )
    log.info('formatted %j', { token: 'format-secret', count: 1 })

    const entries = chunks.map((chunk) => JSON.parse(chunk))
    expect(entries[0]).toMatchObject({
      level: 30,
      msg: 'actual message',
      fieldLevel: 99,
      fieldTime: 0,
      fieldMsg: 'forged',
      module: 'serialized',
      fieldModule: 'forged-module',
      name: 'diagnostic-name',
      timestamp: 123,
      ts: 456,
      token: '[redacted]',
    })
    expect(entries[1]).toMatchObject({
      level: 50,
      msg: 'error message',
      err: {
        type: 'Error',
        message: 'direct failure',
        token: '[redacted]',
      },
    })
    expect(entries[2].msg).toContain('[redacted]')
    expect(JSON.stringify(entries)).not.toContain('field-secret')
    expect(JSON.stringify(entries)).not.toContain('error-secret')
    expect(JSON.stringify(entries)).not.toContain('format-secret')
  })

  it('redacts child bindings and keeps the returned child protected', () => {
    const nestedInfo = vi.fn()
    const nestedChild = { info: nestedInfo }
    const childFactory = vi.fn().mockReturnValue(nestedChild)
    const rootChild = { child: childFactory }
    initLogger({ child: vi.fn().mockReturnValue(rootChild) } as never)

    const child = getLogger('downloads').child({
      url: 'https://example.com/file?token=secret',
      authorization: 'Bearer secret',
    })
    child.info({ cookie: 'session=secret', count: 1 }, 'child message')

    expect(childFactory).toHaveBeenCalledWith(
      {
        url: 'https://example.com/file',
        authorization: '[redacted]',
      },
      undefined
    )
    expect(nestedInfo).toHaveBeenCalledWith(
      { cookie: '[redacted]', count: 1 },
      'child message'
    )
  })
})
