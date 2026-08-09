import type { Logger } from '@core/logger'
import type { TaskOccurrence } from '@shared/types/task-occurrence'

export type OccurrenceConsumer = (occ: TaskOccurrence) => Promise<void> | void

export interface OccurrenceDispatcherDeps {
  listUndispatched: () => TaskOccurrence[]
  markDispatched: (occurrenceId: string) => void
  log: Pick<Logger, 'error' | 'warn'>
}

/**
 * Delivers durably-persisted task occurrences to every registered consumer
 * at least once. Core-only and storage-injected: it never touches the DB or
 * electron directly, only the functions handed in via `deps`.
 */
export class OccurrenceDispatcher {
  private readonly consumers = new Map<string, OccurrenceConsumer>()

  constructor(private readonly deps: OccurrenceDispatcherDeps) {}

  register(name: string, consumer: OccurrenceConsumer): void {
    this.consumers.set(name, consumer)
  }

  /**
   * Run every registered consumer against the occurrence, each in its own
   * try/catch so one misbehaving consumer cannot block the others.
   *
   * The row is stamped `dispatched_at` ONLY when at least one consumer is
   * registered and every one of them completed without throwing. Anything
   * else — a throwing consumer, or no consumers at all — leaves the row
   * undispatched so the next process's `drainAtStartup()` redelivers it.
   * Consumers are idempotent by `occurrenceId`, so a redelivery to the
   * consumers that already succeeded is a no-op. The cost of that
   * at-least-once guarantee is that a permanently-failing consumer keeps
   * its rows in the outbox and re-runs them every startup; a dead-letter
   * cutoff is tracked as follow-up work.
   */
  async dispatch(occ: TaskOccurrence): Promise<void> {
    if (this.consumers.size === 0) {
      this.deps.log.warn(
        { occurrenceId: occ.occurrenceId },
        'occurrence dispatched with no registered consumers; left undispatched for startup drain'
      )
      return
    }
    const failedConsumers: string[] = []
    for (const [name, consumer] of this.consumers) {
      try {
        await consumer(occ)
      } catch (err) {
        failedConsumers.push(name)
        this.deps.log.error(
          { err, consumerName: name, occurrenceId: occ.occurrenceId },
          'occurrence consumer threw'
        )
      }
    }
    if (failedConsumers.length > 0) {
      this.deps.log.warn(
        { occurrenceId: occ.occurrenceId, failedConsumers },
        'occurrence left undispatched after consumer failures; startup drain will redeliver it'
      )
      return
    }
    this.deps.markDispatched(occ.occurrenceId)
  }

  /** Dispatch every undispatched row (created_at ASC) once, at process start. */
  async drainAtStartup(): Promise<void> {
    for (const occ of this.deps.listUndispatched()) {
      await this.dispatch(occ)
    }
  }
}
