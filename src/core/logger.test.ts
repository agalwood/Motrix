import { describe, expect, it, vi } from 'vitest'
import { getLogger, initLogger } from './logger'

describe('logger', () => {
  it('getLogger returns a pino child logger with module field', () => {
    const log = getLogger('engine')
    expect(log).toBeDefined()
    expect(typeof log.info).toBe('function')
    expect(typeof log.error).toBe('function')
    expect(typeof log.warn).toBe('function')
    expect(typeof log.debug).toBe('function')
    expect(typeof log.fatal).toBe('function')
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
})
