import { NotificationKinds } from '@shared/types/notification'
import type { DnsResolutionMode } from '@shared/types/settings'
import { TaskStatus } from '@shared/types/task'
import type { TaskOccurrence } from '@shared/types/task-occurrence'

// Exact ares_strerror() texts for the c-ares failures that mean "the
// resolver could not reach any DNS server" — the only outcomes where the
// OS resolver may still succeed. Deterministic answers (NXDOMAIN, empty
// answer, SERVFAIL) are excluded: retrying them with another resolver
// cannot change the result.
const DNS_TRANSPORT_FAILURE_TEXTS = [
  'Could not contact DNS servers',
  'Timeout while contacting DNS servers',
  'No DNS servers were configured',
] as const

export function isDnsContactFailure(
  errorMessage: string | null | undefined
): boolean {
  if (!errorMessage) return false
  return DNS_TRANSPORT_FAILURE_TEXTS.some((text) => errorMessage.includes(text))
}

export function dnsModeToAsyncDns(mode: DnsResolutionMode): boolean {
  return mode !== 'system'
}

export interface DnsFallbackDeps {
  getDnsMode(): DnsResolutionMode
  /** `null` when the task no longer exists. */
  getTaskStatus(taskId: string): TaskStatus | null
  getTaskName(taskId: string): string | null
  /** EngineSupervisor.applyAsyncDns — hot-flips aria2's `async-dns`. */
  applyAsyncDns(asyncDns: boolean): Promise<void>
  /** Re-adds an errored task as a fresh engine download. */
  reAddTask(taskId: string): Promise<unknown>
  /** NotificationCenter.notify — sourceKey dedups across redelivery. */
  notify(input: {
    sourceKey: string
    kind: string
    severity: 'info'
    titleKey: string
    titleParams?: Record<string, string>
    bodyKey?: string
    taskId?: string
  }): unknown
  log: {
    info(ctx: Record<string, unknown>, msg: string): void
    warn(ctx: Record<string, unknown>, msg: string): void
  }
  now?: () => number
}

export interface DnsFallbackConsumer {
  name: 'dns-fallback'
  consume(occ: TaskOccurrence): Promise<void>
  /** Re-arms the session latch — call when the user changes `dnsMode`. */
  reset(): void
}

/**
 * Occurrence consumer implementing the `auto` DNS mode: the first task
 * that errors with a c-ares transport failure flips the engine to the
 * system resolver for the rest of the session and is re-added once.
 *
 * Guards, in match order:
 * - only fresh terminal Error occurrences (startup redelivery of old
 *   failures must not trigger surprise retries);
 * - only while `dnsMode` is `auto`;
 * - only c-ares transport failures (see `isDnsContactFailure`);
 * - once per task, and only while the task still sits in Error;
 * - all failures are logged, never rethrown — throwing would make the
 *   dispatcher hold the occurrence for redelivery and loop.
 */
export function createDnsFallbackConsumer(
  deps: DnsFallbackDeps
): DnsFallbackConsumer {
  const startedAt = (deps.now ?? Date.now)()
  let fellBack = false
  const retriedTaskIds = new Set<string>()

  async function consume(occ: TaskOccurrence): Promise<void> {
    if (occ.type !== 'terminal') return
    if (occ.toStatus !== TaskStatus.Error) return
    if (occ.cause === 'user-cancel') return
    if (occ.createdAt < startedAt) return
    if (deps.getDnsMode() !== 'auto') return
    if (!isDnsContactFailure(occ.errorGroup?.errorMessage)) return
    if (retriedTaskIds.has(occ.taskId)) return
    if (deps.getTaskStatus(occ.taskId) !== TaskStatus.Error) return

    // Marked before any awaits: a failure below must not leave the task
    // eligible for another automatic retry.
    retriedTaskIds.add(occ.taskId)

    try {
      if (!fellBack) {
        await deps.applyAsyncDns(false)
        fellBack = true
        deps.log.info(
          { taskId: occ.taskId },
          'dns fallback: switched engine to system resolver'
        )
      }
      await deps.reAddTask(occ.taskId)
      deps.notify({
        sourceKey: `dns-fallback:${occ.occurrenceId}`,
        kind: NotificationKinds.DnsFallback,
        severity: 'info',
        titleKey: 'notification.dnsFallback.title',
        titleParams: { name: deps.getTaskName(occ.taskId) ?? occ.taskId },
        bodyKey: 'notification.dnsFallback.body',
        taskId: occ.taskId,
      })
    } catch (err) {
      deps.log.warn(
        {
          taskId: occ.taskId,
          err: err instanceof Error ? err.message : String(err),
        },
        'dns fallback attempt failed'
      )
    }
  }

  return {
    name: 'dns-fallback',
    consume,
    reset() {
      fellBack = false
      retriedTaskIds.clear()
    },
  }
}
