import { transport } from '@renderer/lib/transport'
import { buildActivityDayBoundaries } from '@renderer/routes/dashboard/activity/activity-calendar-model'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type {
  GetTaskActivityParams,
  TaskActivityDay,
  TaskActivitySnapshot,
  TaskActivityUpdatedPayload,
} from '@shared/types/task-activity'
import { useSyncExternalStore } from 'react'

const MAX_QUEUED_EVENTS = 128
// Focus, visibilitychange, online, and reconnect commonly fire in bursts for
// one user action (a single alt-tab raises both focus and visibilitychange).
// Within this window the burst joins the in-flight request instead of forcing
// a trailing duplicate fetch of the same unchanged range.
const AUTHORITATIVE_REFRESH_MIN_INTERVAL_MS = 2_000

type StoreListener = () => void

export type TaskActivityState =
  | { status: 'loading'; retry: () => Promise<void> }
  | {
      status: 'ready'
      snapshot: TaskActivitySnapshot
      retry: () => Promise<void>
    }
  | {
      status: 'stale'
      snapshot: TaskActivitySnapshot
      retry: () => Promise<void>
    }
  | { status: 'unavailable'; retry: () => Promise<void> }

interface RangeEnvironment {
  signature: string
  params: GetTaskActivityParams
}

interface PendingRequest {
  rangeEpoch: number
  rangeSignature: string
  promise: Promise<void>
}

const subscribers = new Set<StoreListener>()

let state: TaskActivityState = Object.freeze({
  status: 'loading',
  retry,
})
let attached = false
let activitySnapshot: TaskActivitySnapshot | null = null
let activitySnapshotRangeSignature: string | null = null
let rangeEnvironment = buildRangeEnvironment()
let rangeEpoch = 0
let lastAuthoritativeRequestAt = 0
let pendingRequest: PendingRequest | null = null
let queuedEvents: TaskActivityUpdatedPayload[] = []
let queueOverflowed = false
let trailingRequested = false
let midnightTimer: ReturnType<typeof setTimeout> | null = null
let teardownTimer: ReturnType<typeof setTimeout> | null = null
let removeConnectionListener: (() => void) | null = null

function notify(): void {
  for (const listener of subscribers) listener()
}

function publish(next: TaskActivityState, force = false): void {
  if (
    !force &&
    state.status === next.status &&
    ('snapshot' in state ? state.snapshot : undefined) ===
      ('snapshot' in next ? next.snapshot : undefined)
  ) {
    return
  }
  state = Object.freeze(next)
  notify()
}

function publishFromSnapshot(status: 'ready' | 'stale', force = false): void {
  if (!activitySnapshot) return
  publish({ status, snapshot: activitySnapshot, retry }, force)
}

export function buildTaskActivityRange(
  now = new Date()
): GetTaskActivityParams {
  return { days: buildActivityDayBoundaries(now) }
}

// Deliberately fingerprints EVERY boundary: two timezones can agree on the
// range edges while interior DST transitions shift individual day bounds.
export function taskActivityRangeSignature(
  params: GetTaskActivityParams
): string {
  return params.days
    .map((day) => `${day.dateKey}:${day.fromMs}:${day.toMs}`)
    .join('|')
}

function buildRangeEnvironment(now = new Date()): RangeEnvironment {
  const params = buildTaskActivityRange(now)
  return {
    signature: taskActivityRangeSignature(params),
    params,
  }
}

function refreshRange(now = new Date()): boolean {
  const next = buildRangeEnvironment(now)
  if (next.signature === rangeEnvironment.signature) return false
  rangeEnvironment = next
  rangeEpoch += 1
  // A snapshot is meaningful only for the range that produced it. Even when
  // an already-stale fetch fails across midnight, publish a fresh state
  // identity so the calendar recomputes today/future presentation.
  if (activitySnapshot) publishFromSnapshot('stale', true)
  return true
}

function scheduleMidnight(): void {
  if (midnightTimer !== null) clearTimeout(midnightTimer)
  const now = new Date()
  const nextMidnight = new Date(now)
  nextMidnight.setHours(0, 0, 0, 0)
  nextMidnight.setDate(nextMidnight.getDate() + 1)
  midnightTimer = setTimeout(
    () => {
      midnightTimer = null
      if (!attached) return
      const rangeChanged = refreshRange()
      if (!rangeChanged && activitySnapshot) {
        // The 53-week request range changes only on Sunday, but the Canvas
        // model's today/future state changes at every local midnight.
        publishFromSnapshot('stale', true)
      }
      scheduleMidnight()
      void requestSnapshot('authoritative')
    },
    Math.max(1, nextMidnight.getTime() - now.getTime())
  )
}

function immutableSnapshot(
  snapshot: TaskActivitySnapshot
): TaskActivitySnapshot {
  return Object.freeze({
    ...snapshot,
    coverage: Object.freeze({ ...snapshot.coverage }),
    days: Object.freeze(snapshot.days.map((day) => Object.freeze({ ...day }))),
  })
}

function replaceDay(
  days: readonly TaskActivityDay[],
  occurredAt: number,
  update: (day: TaskActivityDay) => TaskActivityDay
): readonly TaskActivityDay[] {
  const boundaries = rangeEnvironment.params.days
  // Live events almost always land on today, so scan from the tail.
  let match = -1
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index]
    if (
      boundary &&
      occurredAt >= boundary.fromMs &&
      occurredAt < boundary.toMs
    ) {
      match = index
      break
    }
  }
  if (match < 0 || !days[match]) return days
  const next = [...days]
  next[match] = Object.freeze(update(days[match]))
  return Object.freeze(next)
}

function applyContiguousEvent(payload: TaskActivityUpdatedPayload): boolean {
  const current = activitySnapshot
  if (
    !current ||
    activitySnapshotRangeSignature !== rangeEnvironment.signature ||
    payload.generation !== current.generation
  ) {
    return false
  }
  if (payload.revision <= current.revision) return true
  if (payload.revision !== current.revision + 1) return false

  let days = current.days
  let coverage = current.coverage
  if (payload.type === 'inserted') {
    days = replaceDay(days, payload.event.occurredAt, (day) => {
      if (payload.event.kind === 'submitted') {
        return { ...day, submitted: day.submitted + 1 }
      }
      return {
        ...day,
        downloadCompleted: day.downloadCompleted + 1,
        recoveredDownloadCompleted:
          day.recoveredDownloadCompleted +
          (payload.event.accuracy === 'recovered' ? 1 : 0),
      }
    })
  } else {
    coverage = Object.freeze({
      ...coverage,
      coverageGapAt:
        coverage.coverageGapAt === null
          ? payload.coverageGapAt
          : Math.min(coverage.coverageGapAt, payload.coverageGapAt),
    })
  }

  activitySnapshot = Object.freeze({
    ...current,
    revision: payload.revision,
    coverage,
    days,
  })
  publishFromSnapshot('ready')
  return true
}

function markDirty(): void {
  if (pendingRequest) trailingRequested = true
}

function processEvent(payload: TaskActivityUpdatedPayload): void {
  const current = activitySnapshot
  if (
    current &&
    payload.generation === current.generation &&
    applyContiguousEvent(payload)
  ) {
    return
  }

  markDirty()
  if (current) publishFromSnapshot('stale')
  if (!pendingRequest) void requestSnapshot()
}

function queueEvent(payload: TaskActivityUpdatedPayload): void {
  if (queueOverflowed) {
    markDirty()
    return
  }
  if (queuedEvents.length >= MAX_QUEUED_EVENTS) {
    queuedEvents = []
    queueOverflowed = true
    markDirty()
    return
  }
  queuedEvents.push(payload)
}

function onActivityUpdated(...args: unknown[]): void {
  const payload = args[0] as TaskActivityUpdatedPayload
  if (pendingRequest) {
    queueEvent(payload)
    return
  }
  processEvent(payload)
}

function drainQueuedEvents(): void {
  if (queueOverflowed) {
    queuedEvents = []
    queueOverflowed = false
    markDirty()
    return
  }
  if (queuedEvents.length === 0) return

  const queued = queuedEvents
  queuedEvents = []
  const generation = activitySnapshot?.generation
  const matching = queued
    .filter((payload) => payload.generation === generation)
    .sort((a, b) => a.revision - b.revision)
  const hasOtherGeneration = matching.length !== queued.length

  for (const payload of matching) {
    if (!applyContiguousEvent(payload)) {
      markDirty()
      break
    }
  }
  if (hasOtherGeneration) markDirty()
}

// Detach and replacement both clear `pendingRequest`, so request identity
// already proves the request is still current; only the range can move on
// independently underneath an in-flight fetch.
function canPublish(request: PendingRequest): boolean {
  return (
    attached && pendingRequest === request && rangeEpoch === request.rangeEpoch
  )
}

type SnapshotRequestReason = 'deduplicated' | 'authoritative'

function requestSnapshot(
  reason: SnapshotRequestReason = 'deduplicated'
): Promise<void> {
  if (!attached) return Promise.resolve()
  if (pendingRequest) {
    if (
      reason === 'authoritative' ||
      pendingRequest.rangeEpoch !== rangeEpoch
    ) {
      markDirty()
    }
    return pendingRequest.promise
  }

  const capturedRangeEpoch = rangeEpoch
  const capturedRangeSignature = rangeEnvironment.signature
  const params = rangeEnvironment.params
  if (activitySnapshot) publishFromSnapshot('stale')
  else publish({ status: 'loading', retry })

  let request!: PendingRequest
  const work = transport
    .invoke(Queries.GetTaskActivity, params)
    .then((value) => {
      if (!canPublish(request)) return
      const incoming = immutableSnapshot(value as TaskActivitySnapshot)
      if (
        activitySnapshot?.generation === incoming.generation &&
        incoming.revision < activitySnapshot.revision
      ) {
        markDirty()
        return
      }
      activitySnapshot = incoming
      activitySnapshotRangeSignature = request.rangeSignature
      publishFromSnapshot('ready')
      drainQueuedEvents()
    })
    .catch(() => {
      if (!canPublish(request)) return
      if (activitySnapshot) publishFromSnapshot('stale')
      else publish({ status: 'unavailable', retry })
      drainQueuedEvents()
    })

  const promise = work.finally(() => {
    if (pendingRequest !== request) return
    pendingRequest = null
    if (!attached) return
    if (trailingRequested) {
      trailingRequested = false
      void requestSnapshot()
    }
  })
  request = {
    rangeEpoch: capturedRangeEpoch,
    rangeSignature: capturedRangeSignature,
    promise,
  }
  pendingRequest = request
  return promise
}

function retry(): Promise<void> {
  refreshRange()
  scheduleMidnight()
  return requestSnapshot()
}

function forceSnapshot(): void {
  refreshRange()
  scheduleMidnight()
  const now = Date.now()
  if (
    now - lastAuthoritativeRequestAt <
    AUTHORITATIVE_REFRESH_MIN_INTERVAL_MS
  ) {
    void requestSnapshot()
    return
  }
  lastAuthoritativeRequestAt = now
  void requestSnapshot('authoritative')
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') forceSnapshot()
}

function attach(): void {
  if (attached) return
  attached = true
  transport.on(Events.TaskActivityUpdated, onActivityUpdated)
  removeConnectionListener =
    transport.onConnectionChange?.((event) => {
      // Reconcile on the first successful socket connection as well as on
      // reconnect. An activity event can land after the HTTP snapshot but
      // before the initial WebSocket finishes opening; without this fetch
      // that revision would remain invisible until a later focus/online event.
      if (event.state === 'connected') forceSnapshot()
    }) ?? null
  window.addEventListener('focus', forceSnapshot)
  window.addEventListener('online', forceSnapshot)
  document.addEventListener('visibilitychange', onVisibilityChange)
  refreshRange()
  scheduleMidnight()
  void requestSnapshot()
}

function detach(): void {
  if (!attached) return
  transport.off(Events.TaskActivityUpdated, onActivityUpdated)
  removeConnectionListener?.()
  removeConnectionListener = null
  window.removeEventListener('focus', forceSnapshot)
  window.removeEventListener('online', forceSnapshot)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  if (midnightTimer !== null) {
    clearTimeout(midnightTimer)
    midnightTimer = null
  }
  attached = false
  lastAuthoritativeRequestAt = 0
  pendingRequest = null
  queuedEvents = []
  queueOverflowed = false
  trailingRequested = false
}

function cancelDeferredTeardown(): void {
  if (teardownTimer === null) return
  clearTimeout(teardownTimer)
  teardownTimer = null
}

function scheduleDeferredTeardown(): void {
  if (teardownTimer !== null) return
  teardownTimer = setTimeout(() => {
    teardownTimer = null
    if (subscribers.size === 0) detach()
  }, 0)
}

function subscribe(listener: StoreListener): () => void {
  cancelDeferredTeardown()
  subscribers.add(listener)
  attach()
  return () => {
    subscribers.delete(listener)
    if (subscribers.size === 0) scheduleDeferredTeardown()
  }
}

function getSnapshot(): TaskActivityState {
  return state
}

const getServerSnapshot = getSnapshot

export function useTaskActivity(): TaskActivityState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** Internal test seam. */
export function __resetTaskActivityStoreForTests(): void {
  cancelDeferredTeardown()
  detach()
  subscribers.clear()
  rangeEpoch = 0
  lastAuthoritativeRequestAt = 0
  pendingRequest = null
  queuedEvents = []
  queueOverflowed = false
  trailingRequested = false
  activitySnapshot = null
  activitySnapshotRangeSignature = null
  rangeEnvironment = buildRangeEnvironment()
  state = Object.freeze({ status: 'loading', retry })
}
