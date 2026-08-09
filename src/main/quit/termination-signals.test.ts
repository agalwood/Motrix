import { describe, expect, it, vi } from 'vitest'
import {
  DEV_SHUTDOWN_MESSAGE,
  type DevShutdownMessageSource,
  registerDevShutdownHandler,
  registerTerminationSignalHandlers,
  type TerminationSignal,
  type TerminationSignalSource,
} from './termination-signals'

function createSignalSource() {
  const listeners = new Map<
    TerminationSignal,
    (signal: TerminationSignal) => void
  >()
  const source: TerminationSignalSource = {
    on: vi.fn((signal, listener) => {
      listeners.set(signal, listener)
    }),
    off: vi.fn((signal, listener) => {
      if (listeners.get(signal) === listener) listeners.delete(signal)
    }),
  }
  return {
    source,
    emit(signal: TerminationSignal) {
      listeners.get(signal)?.(signal)
    },
    listeners,
  }
}

describe('registerTerminationSignalHandlers', () => {
  it('forwards the first termination signal only', () => {
    const target = createSignalSource()
    const onTermination = vi.fn()
    registerTerminationSignalHandlers(onTermination, target.source)

    target.emit('SIGTERM')
    target.emit('SIGINT')

    expect(onTermination).toHaveBeenCalledOnce()
    expect(onTermination).toHaveBeenCalledWith('SIGTERM')
  })

  it('removes both signal handlers', () => {
    const target = createSignalSource()
    const dispose = registerTerminationSignalHandlers(vi.fn(), target.source)

    dispose()

    expect(target.listeners.size).toBe(0)
    expect(target.source.off).toHaveBeenCalledTimes(2)
  })
})

describe('registerDevShutdownHandler', () => {
  it('accepts only the dev runner shutdown message', () => {
    let listener: ((message: unknown) => void) | undefined
    const source: DevShutdownMessageSource = {
      on: vi.fn((_event, nextListener) => {
        listener = nextListener
      }),
      off: vi.fn(),
    }
    const onTermination = vi.fn()
    registerDevShutdownHandler(onTermination, source)

    listener?.('unrelated-message')
    listener?.(DEV_SHUTDOWN_MESSAGE)

    expect(onTermination).toHaveBeenCalledOnce()
  })
})
