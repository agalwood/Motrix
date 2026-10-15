import { z } from 'zod'
import {
  notificationText,
  type SafariNotificationTransport,
} from '@/background/SafariNotificationTransport'
import { i18n } from '@/shared/i18n'
import {
  isSeverityEnabled,
  NOTIFICATION_KINDS,
  type NotificationSource,
  type NotificationsConfig,
  type NotificationTaskProgress,
  type NotifyInput,
} from '@/shared/notifications'

const STORAGE_KEY = 'motrix.notificationOutbox.v1'
const MAX_PENDING = 64
const MAX_RECEIPTS = 4096
const MAX_AGE = 120_000
const RETENTION = 7 * 24 * 60 * 60 * 1000
const FAILURE_WINDOW = 10 * 60 * 1000
const RATE_WINDOW = 60_001
const progressSchema = z.object({
  bytesDone: z.number().finite().nonnegative(),
  phase: z.enum(['queued', 'downloading', 'muxing', 'finalizing']),
})
const failureSchema = z.object({
  key: z.string().min(1).max(128),
  progress: progressSchema.nullable(),
  until: z.number().finite(),
})
const sourceSchema = z.object({
  endpointId: z.string().max(256),
  endpointRevision: z.number().int().nonnegative(),
  instanceId: z.string().max(256).nullable(),
})
const recordSchema = z.object({
  id: z.string().uuid(),
  key: z.string().min(1).max(128),
  title: z.string().max(240),
  message: z.string().max(600),
  severity: z.enum(['confirm', 'error', 'reminder']),
  kind: z.enum(NOTIFICATION_KINDS).default('download.feedback'),
  source: sourceSchema.optional(),
  expiresAt: z.number().finite(),
  retainUntil: z.number().finite(),
  failureGroup: z.string().min(1).max(128).optional(),
  notBefore: z.number().finite().optional(),
})
const receiptSchema = z.object({
  key: z.string().max(128),
  until: z.number().finite(),
  failureGroup: z.string().min(1).max(128).optional(),
})
type Record = z.infer<typeof recordSchema>
type Receipt = z.infer<typeof receiptSchema>
interface State {
  pending: Record[]
  receipts: Receipt[]
  failures: z.infer<typeof failureSchema>[]
}

interface OutboxDependencies {
  storage: {
    get(key: string): Promise<{ [key: string]: unknown }>
    set(value: { [key: string]: unknown }): Promise<void>
  }
  preferences: { get(): Promise<NotificationsConfig> }
  transport: Pick<SafariNotificationTransport, 'send'>
  isCurrentSource(source: NotificationSource): boolean
  now?: () => number
}

/** One background owns the JS queue; the native receipt transaction owns final delivery. */
export class NotificationOutbox {
  private tail: Promise<void> = Promise.resolve()
  private queued = 0
  private readonly guards = new Map<string, () => boolean>()
  private readonly now: () => number
  private knownFailureKeys: Set<string> | undefined

  constructor(private readonly deps: OutboxDependencies) {
    this.now = deps.now ?? Date.now
  }

  enqueue(input: NotifyInput): Promise<void> {
    // Bound waiting closures as well as persisted events during a stalled host.
    if (this.queued >= MAX_PENDING) return Promise.resolve()
    this.queued += 1
    const createdAt = this.now()
    return this.run(async () => {
      if (
        input.isCurrent?.() === false ||
        !isSeverityEnabled(await this.deps.preferences.get(), input.severity)
      )
        return
      const state = await this.read()
      const key = input.deduplicationKey
        ? await this.digest(
            JSON.stringify([input.source ?? null, input.deduplicationKey])
          )
        : crypto.randomUUID()
      if (
        state.receipts.some((receipt) => receipt.key === key) ||
        state.pending.some((record) => record.key === key)
      ) {
        await this.deliver(state)
        return
      }
      // Reserve room for every pending event's receipt before admitting another.
      if (
        state.pending.length >= MAX_PENDING ||
        state.receipts.length + state.pending.length >= MAX_RECEIPTS
      )
        return
      const record: Record = {
        id: crypto.randomUUID(),
        key,
        title: notificationText(input.title, 120),
        message: notificationText(input.message, 300),
        severity: input.severity,
        kind: input.kind ?? 'download.feedback',
        ...(input.source ? { source: { ...input.source } } : {}),
        expiresAt: createdAt + MAX_AGE,
        retainUntil:
          createdAt +
          Math.min(
            RETENTION,
            Math.max(
              0,
              typeof input.deduplicationMs === 'number' &&
                Number.isFinite(input.deduplicationMs)
                ? input.deduplicationMs
                : RETENTION
            )
          ),
      }
      if (
        input.kind === 'task.failed' &&
        input.failure &&
        input.source?.instanceId != null
      ) {
        const group = await this.failureKey(input.source, input.failure.taskId)
        const previous = state.failures.find((failure) => failure.key === group)
        if (previous || state.failures.length < MAX_RECEIPTS) {
          record.failureGroup = group
          const parsed = progressSchema.safeParse(input.failure.progress)
          if (previous) {
            previous.until = Math.max(
              previous.until,
              createdAt + FAILURE_WINDOW
            )
            // A duplicate error without a progress snapshot must not erase it.
            if (parsed.success) previous.progress = parsed.data
          } else {
            state.failures.push({
              key: group,
              progress: parsed.success ? parsed.data : null,
              until: createdAt + FAILURE_WINDOW,
            })
          }
        }
      }
      this.guards.set(record.id, input.isCurrent ?? (() => true))
      state.pending.push(record)
      // Do not submit anything unless its event identity is durable first.
      await this.write(state)
      await this.deliver(state)
    }).finally(() => {
      this.queued -= 1
    })
  }

  flush(): Promise<void> {
    return this.run(async () => this.deliver(await this.read()))
  }

  observeTaskProgress(input: NotificationTaskProgress): Promise<void> {
    if (this.queued >= MAX_PENDING) return Promise.resolve()
    this.queued += 1
    return this.run(async () => {
      const current = () =>
        input.source.instanceId != null &&
        input.isCurrent?.() !== false &&
        this.deps.isCurrentSource(input.source)
      if (!current()) return
      const key = await this.failureKey(input.source, input.taskId)
      // Once loaded, progress for unrelated active tasks causes no storage I/O.
      if (this.knownFailureKeys?.has(key) === false) return
      const state = await this.read()
      const failure = state.failures.find((item) => item.key === key)
      const parsed = progressSchema.safeParse(input)
      if (!failure || !parsed.success || !current()) return
      const next = parsed.data
      const previous = failure.progress
      if (
        previous?.bytesDone === next.bytesDone &&
        previous.phase === next.phase
      )
        return
      const phaseOrder = { queued: 0, downloading: 1, muxing: 2, finalizing: 3 }
      const advanced =
        previous !== null &&
        next.phase !== 'queued' &&
        (next.bytesDone > previous.bytesDone ||
          (phaseOrder[next.phase] >= 2 &&
            phaseOrder[next.phase] > phaseOrder[previous.phase]))
      const removedIds: string[] = []
      if (advanced) {
        // Rearm only this task's failures; completion receipts remain untouched.
        state.receipts = state.receipts.filter(
          (item) => item.failureGroup !== key
        )
        state.pending = state.pending.filter((item) => {
          if (item.failureGroup !== key) return true
          removedIds.push(item.id)
          return false
        })
        state.failures = state.failures.filter((item) => item.key !== key)
      } else {
        // A restart can reset bytes to zero. Save that baseline, but wait for
        // observed advancement rather than treating a queued/duplicate tick as work.
        failure.progress = next
      }
      await this.write(state)
      for (const id of removedIds) this.guards.delete(id)
    }).finally(() => {
      this.queued -= 1
    })
  }

  private run(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }

  private async deliver(state: State): Promise<void> {
    for (const record of [...state.pending]) {
      const canSend = async () => {
        const cfg = await this.deps.preferences.get()
        const guard = this.guards.get(record.id)
        const current = guard
          ? guard()
          : record.source?.instanceId != null &&
            this.deps.isCurrentSource(record.source)
        return (
          record.expiresAt > this.now() &&
          current &&
          isSeverityEnabled(cfg, record.severity)
        )
      }
      if (await canSend()) {
        if (record.notBefore !== undefined && record.notBefore > this.now())
          continue
        // The transport rechecks canSend after native capability negotiation.
        const result = await this.deps.transport.send(
          {
            title: record.title,
            message: record.message,
            severity: record.severity,
            kind: record.kind,
          },
          record.id,
          {
            expiresAt: record.expiresAt,
            canSend,
          }
        )
        if (result === 'rateLimited' && (await canSend())) {
          if (record.kind === 'task.summary') {
            // Keep the same durable identity and original expiry. Only a later
            // natural wakeup may try again; no timer keeps the background alive.
            record.notBefore = this.now() + RATE_WINDOW
            await this.write(state)
            continue
          }
          if (
            (record.kind === 'task.completed' ||
              record.kind === 'task.failed') &&
            record.source?.instanceId != null
          ) {
            this.mergeSummary(state, record)
          }
        }
      }
      state.pending = state.pending.filter((item) => item.id !== record.id)
      this.guards.delete(record.id)
      if (record.retainUntil > this.now())
        state.receipts.push({
          key: record.key,
          until: record.retainUntil,
          ...(record.failureGroup ? { failureGroup: record.failureGroup } : {}),
        })
      await this.write(state)
    }
    // Pruned entries are persisted even when no live event remains.
    await this.write(state)
  }

  private mergeSummary(state: State, record: Record): void {
    const sameSource = (other: Record) =>
      other.source?.endpointId === record.source?.endpointId &&
      other.source?.endpointRevision === record.source?.endpointRevision &&
      other.source?.instanceId === record.source?.instanceId
    if (
      state.pending.some(
        (other) =>
          other.kind === 'task.summary' &&
          other.severity === record.severity &&
          sameSource(other)
      )
    )
      return
    // Reserve the summary's receipt without evicting previous delivery records.
    if (
      state.pending.length >= MAX_PENDING ||
      state.pending.length + state.receipts.length >= MAX_RECEIPTS
    )
      return
    const summary: Record = {
      id: crypto.randomUUID(),
      key: crypto.randomUUID(),
      kind: 'task.summary',
      severity: record.severity,
      title: notificationText(i18n.t('notify.taskUpdatesTitle'), 120),
      message: notificationText(i18n.t('notify.taskDetailsBody'), 300),
      ...(record.source ? { source: { ...record.source } } : {}),
      expiresAt: record.expiresAt,
      retainUntil: record.expiresAt,
      notBefore: this.now() + RATE_WINDOW,
    }
    // A summary is always bound to its authenticated source, including after
    // the originating connection disappears or the background restarts.
    state.pending.push(summary)
  }

  private async read(): Promise<State> {
    const stored = (await this.deps.storage.get(STORAGE_KEY))[STORAGE_KEY]
    const data =
      stored && typeof stored === 'object'
        ? (stored as {
            pending?: unknown
            receipts?: unknown
            failures?: unknown
          })
        : {}
    const pending = (Array.isArray(data.pending) ? data.pending : [])
      .slice(0, MAX_PENDING)
      .flatMap((value) => {
        const parsed = recordSchema.safeParse(value)
        return parsed.success ? [parsed.data] : []
      })
      .filter(
        (record) =>
          record.expiresAt > 0 &&
          record.expiresAt <= this.now() + MAX_AGE &&
          record.retainUntil <= this.now() + RETENTION &&
          (record.notBefore === undefined ||
            record.notBefore <= this.now() + RATE_WINDOW)
      )
    const receipts = (Array.isArray(data.receipts) ? data.receipts : [])
      .slice(0, MAX_RECEIPTS)
      .flatMap((value) => {
        const parsed = receiptSchema.safeParse(value)
        return parsed.success ? [parsed.data] : []
      })
      .filter(
        (receipt) =>
          receipt.until > this.now() && receipt.until <= this.now() + RETENTION
      )
    const live = new Set(pending.map((record) => record.id))
    for (const id of this.guards.keys())
      if (!live.has(id)) this.guards.delete(id)
    const failures = (Array.isArray(data.failures) ? data.failures : [])
      .slice(0, MAX_RECEIPTS)
      .flatMap((value) => {
        const parsed = failureSchema.safeParse(value)
        return parsed.success ? [parsed.data] : []
      })
      .filter(
        (failure) =>
          failure.until > this.now() &&
          failure.until <= this.now() + FAILURE_WINDOW
      )
    this.knownFailureKeys = new Set(failures.map((failure) => failure.key))
    return {
      pending: pending.slice(0, MAX_RECEIPTS - receipts.length),
      receipts,
      failures,
    }
  }

  private async write(state: State): Promise<void> {
    await this.deps.storage.set({ [STORAGE_KEY]: state })
    this.knownFailureKeys = new Set(
      state.failures.map((failure) => failure.key)
    )
  }

  private failureKey(
    source: NotificationSource,
    taskId: string
  ): Promise<string> {
    return this.digest(
      JSON.stringify([
        source.endpointId,
        source.endpointRevision,
        source.instanceId,
        taskId,
      ])
    )
  }

  private async digest(value: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value)
    )
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
  }
}
