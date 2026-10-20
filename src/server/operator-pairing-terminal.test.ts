// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const reader = vi.hoisted(() => ({ current: null as EventEmitter | null }))
vi.mock('node:readline/promises', () => ({
  createInterface: () => {
    const emitter = new EventEmitter()
    reader.current = emitter
    return Object.assign(emitter, { close: () => emitter.emit('close') })
  },
}))

import { createPairingTerminal } from './operator-extension-pairing'

afterEach(() => vi.restoreAllMocks())

describe('default pairing terminal lifecycle', () => {
  it.each(['SIGINT', 'SIGTSTP', 'close'])(
    'cancels on readline %s and clears the sensitive screen',
    (event) => {
      const write = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true)
      const before = process.listenerCount('SIGTSTP')
      const terminal = createPairingTerminal()
      try {
        terminal.begin()
        terminal.show(['fixture-secret'])
        reader.current!.emit(event)
        expect(terminal.signal.aborted).toBe(true)
      } finally {
        terminal.close()
      }
      expect(write.mock.calls.map(([text]) => text).slice(-2)).toEqual([
        '\x1b[2J\x1b[H',
        '\x1b[?1049l',
      ])
      expect(process.listenerCount('SIGTSTP')).toBe(before)
    }
  )
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTSTP'] as const)(
    'cancels on process %s and removes its listener',
    (signal) => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const before = process.listeners(signal)
      const terminal = createPairingTerminal()
      try {
        terminal.begin()
        const cancel = process
          .listeners(signal)
          .find((listener) => !before.includes(listener)) as (
          signal: NodeJS.Signals
        ) => void
        cancel(signal)
        expect(terminal.signal.aborted).toBe(true)
      } finally {
        terminal.close()
      }
      expect(process.listeners(signal)).toEqual(before)
    }
  )
})
