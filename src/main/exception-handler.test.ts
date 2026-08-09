import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsReady, mockSend } = vi.hoisted(() => ({
  mockIsReady: vi.fn().mockReturnValue(true),
  mockSend: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isReady: mockIsReady },
}))

vi.mock('@core/logger', () => ({
  getLogger: () => ({
    fatal: vi.fn(),
    error: vi.fn(),
  }),
}))

import { setupExceptionHandler } from './exception-handler'

describe('setupExceptionHandler', () => {
  const listeners = new Map<string, (...args: unknown[]) => void>()

  beforeEach(() => {
    vi.clearAllMocks()
    listeners.clear()

    vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      listener: (...args: unknown[]) => void
    ) => {
      listeners.set(event, listener)
      return process
    }) as typeof process.on)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers uncaughtException and unhandledRejection handlers', () => {
    setupExceptionHandler({
      isDev: false,
      getWindow: () => null,
      onFatalError: async () => {},
    })

    expect(listeners.has('uncaughtException')).toBe(true)
    expect(listeners.has('unhandledRejection')).toBe(true)
  })

  it('calls onFatalError on uncaughtException in production', async () => {
    const onFatalError = vi.fn().mockResolvedValue(undefined)
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as never)

    setupExceptionHandler({
      isDev: false,
      getWindow: () => null,
      onFatalError,
    })

    const handler = listeners.get('uncaughtException')
    if (!handler) throw new Error('handler not registered')
    handler(new Error('test crash'), 'uncaughtException')

    await vi.waitFor(() => {
      expect(onFatalError).toHaveBeenCalled()
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    mockExit.mockRestore()
  })

  it('sends AppError to renderer on unhandledRejection', () => {
    const mockWindow = {
      isDestroyed: () => false,
      webContents: { send: mockSend },
    }

    setupExceptionHandler({
      isDev: false,
      getWindow: () => mockWindow as never,
      onFatalError: async () => {},
    })

    const handler = listeners.get('unhandledRejection')
    if (!handler) throw new Error('handler not registered')
    handler(new Error('rejected'), Promise.resolve())

    expect(mockSend).toHaveBeenCalledWith(
      'event:appError',
      expect.objectContaining({ message: 'rejected', fatal: false })
    )
  })
})
