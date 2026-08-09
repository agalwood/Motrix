import { TaskStatus } from '@shared/types/task'
import type {
  TaskOccurrence,
  TaskTerminalOccurrence,
} from '@shared/types/task-occurrence'
import { describe, expect, it, vi } from 'vitest'
import { OccurrenceDispatcher } from './occurrence-dispatcher'

function makeTerminalOccurrence(
  overrides: Partial<TaskTerminalOccurrence> = {}
): TaskTerminalOccurrence {
  return {
    occurrenceId: 'occ-1',
    type: 'terminal',
    taskId: 'task-1',
    fromStatus: TaskStatus.Downloading,
    toStatus: TaskStatus.Error,
    cause: 'engine',
    errorGroup: null,
    createdAt: 1000,
    ...overrides,
  }
}

function makeLog() {
  return { error: vi.fn(), warn: vi.fn() }
}

describe('OccurrenceDispatcher', () => {
  describe('dispatch', () => {
    it('delivers the occurrence to every registered consumer', async () => {
      const markDispatched = vi.fn()
      const dispatcher = new OccurrenceDispatcher({
        listUndispatched: vi.fn().mockReturnValue([]),
        markDispatched,
        log: makeLog(),
      })
      const occ = makeTerminalOccurrence()
      const consumerA = vi.fn()
      const consumerB = vi.fn()
      dispatcher.register('a', consumerA)
      dispatcher.register('b', consumerB)

      await dispatcher.dispatch(occ)

      expect(consumerA).toHaveBeenCalledWith(occ)
      expect(consumerB).toHaveBeenCalledWith(occ)
    })

    it('a throwing consumer does not block others but leaves the row undispatched', async () => {
      const markDispatched = vi.fn()
      const log = makeLog()
      const dispatcher = new OccurrenceDispatcher({
        listUndispatched: vi.fn().mockReturnValue([]),
        markDispatched,
        log,
      })
      const occ = makeTerminalOccurrence()
      const afterConsumer = vi.fn()
      dispatcher.register('throws', () => {
        throw new Error('boom')
      })
      dispatcher.register('after', afterConsumer)

      await expect(dispatcher.dispatch(occ)).resolves.toBeUndefined()

      expect(afterConsumer).toHaveBeenCalledWith(occ)
      expect(markDispatched).not.toHaveBeenCalled()
      expect(log.error).toHaveBeenCalledTimes(1)
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ failedConsumers: ['throws'] }),
        expect.any(String)
      )
    })

    it('an asynchronously rejecting consumer does not block others but leaves the row undispatched', async () => {
      const markDispatched = vi.fn()
      const log = makeLog()
      const dispatcher = new OccurrenceDispatcher({
        listUndispatched: vi.fn().mockReturnValue([]),
        markDispatched,
        log,
      })
      const occ = makeTerminalOccurrence()
      const afterConsumer = vi.fn()
      dispatcher.register('rejects', async () => {
        throw new Error('async boom')
      })
      dispatcher.register('after', afterConsumer)

      await expect(dispatcher.dispatch(occ)).resolves.toBeUndefined()

      expect(afterConsumer).toHaveBeenCalledWith(occ)
      expect(markDispatched).not.toHaveBeenCalled()
      expect(log.error).toHaveBeenCalledTimes(1)
    })

    it('leaves the row undispatched when no consumer is registered', async () => {
      const markDispatched = vi.fn()
      const log = makeLog()
      const dispatcher = new OccurrenceDispatcher({
        listUndispatched: vi.fn().mockReturnValue([]),
        markDispatched,
        log,
      })

      await dispatcher.dispatch(makeTerminalOccurrence())

      expect(markDispatched).not.toHaveBeenCalled()
      expect(log.warn).toHaveBeenCalledTimes(1)
    })

    it('stamps dispatched only after every consumer has succeeded', async () => {
      const order: string[] = []
      const dispatcher = new OccurrenceDispatcher({
        listUndispatched: vi.fn().mockReturnValue([]),
        markDispatched: (id) => order.push(`mark:${id}`),
        log: makeLog(),
      })
      const occ = makeTerminalOccurrence()
      dispatcher.register('a', () => {
        order.push('a')
      })
      dispatcher.register('b', () => {
        order.push('b')
      })

      await dispatcher.dispatch(occ)

      expect(order).toEqual(['a', 'b', `mark:${occ.occurrenceId}`])
    })
  })

  describe('drainAtStartup', () => {
    it('dispatches every undispatched row in created_at order and stamps each', async () => {
      const occ1 = makeTerminalOccurrence({
        occurrenceId: 'occ-1',
        createdAt: 100,
      })
      const occ2 = makeTerminalOccurrence({
        occurrenceId: 'occ-2',
        createdAt: 200,
      })
      const received: string[] = []
      const marked: string[] = []
      const dispatcher = new OccurrenceDispatcher({
        listUndispatched: vi.fn().mockReturnValue([occ1, occ2]),
        markDispatched: (id) => marked.push(id),
        log: makeLog(),
      })
      dispatcher.register('recorder', (occ: TaskOccurrence) => {
        received.push(occ.occurrenceId)
      })

      await dispatcher.drainAtStartup()

      expect(received).toEqual(['occ-1', 'occ-2'])
      expect(marked).toEqual(['occ-1', 'occ-2'])
    })

    it('does nothing when there are no undispatched rows', async () => {
      const markDispatched = vi.fn()
      const dispatcher = new OccurrenceDispatcher({
        listUndispatched: vi.fn().mockReturnValue([]),
        markDispatched,
        log: makeLog(),
      })

      await dispatcher.drainAtStartup()

      expect(markDispatched).not.toHaveBeenCalled()
    })
  })
})
