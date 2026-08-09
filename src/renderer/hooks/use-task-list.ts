import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { useSyncExternalStore } from 'react'

const ACTIVE_STATUSES: readonly TaskStatus[] = [
  TaskStatus.Queued,
  TaskStatus.FetchingMetadata,
  TaskStatus.MetadataReady,
  TaskStatus.Downloading,
  TaskStatus.Seeding,
]

const STOPPED_STATUSES: readonly TaskStatus[] = [
  TaskStatus.Completed,
  TaskStatus.Error,
  TaskStatus.Removed,
]

export type TaskListStatus = 'loading' | 'ready' | 'error'

export interface TaskListAggregates {
  tasks: readonly DownloadTask[]
  status: TaskListStatus
  hasReadySnapshot: boolean
  revision: number
  retry(): Promise<void>
  hasAnyActive: boolean
  hasAnyPaused: boolean
  hasStopped: boolean
}

interface PublishOptions {
  tasks?: readonly DownloadTask[]
  status?: TaskListStatus
  hasReadySnapshot?: boolean
}

interface PendingRequest {
  epoch: number
  generation: number
  promise: Promise<void>
}

type StoreListener = () => void

const EMPTY_TASKS: readonly DownloadTask[] = Object.freeze([])
const subscribers = new Set<StoreListener>()

let snapshot: TaskListAggregates = createSnapshot(
  EMPTY_TASKS,
  'loading',
  false,
  0
)
let listenersAttached = false
let detachConnectionListener: (() => void) | null = null
let lifecycleEpoch = 0
let dataGeneration = 0
let pendingRequest: PendingRequest | null = null
let legacyRefreshRequested = false
let teardownTimer: ReturnType<typeof setTimeout> | null = null

// A failed re-snapshot while a ready snapshot is on screen is nearly
// invisible (downloads-page only shows a slim stale banner) and the
// delta-gated poll tick never re-broadcasts an unchanged engine — without a
// retry, removal/terminal frames missed during a disconnect stay stale until
// the next unrelated task event. The retry loop is UNBOUNDED with a capped
// delay: the snapshot query rides its own HTTP POST, which can stay broken
// long after the WS settles into connected — a finite budget would strand
// the stale list with no future edge to rescue it.
const RESYNC_RETRY_BASE_DELAY_MS = 1_000
const RESYNC_RETRY_MAX_DELAY_MS = 30_000
// A transport request has no deadline of its own; a hung fetch must not pin
// pendingRequest forever and wedge the coalescer.
const SNAPSHOT_DEADLINE_MS = 15_000
let resyncRetryTimer: ReturnType<typeof setTimeout> | null = null
let resyncRetryAttempt = 0

function cancelResyncRetry(): void {
  if (resyncRetryTimer === null) return
  clearTimeout(resyncRetryTimer)
  resyncRetryTimer = null
}

/** Fresh authoritative data or a new connected edge — stop any pending
 *  retry and restore the attempt budget. */
function resetResyncRetry(): void {
  cancelResyncRetry()
  resyncRetryAttempt = 0
}

function scheduleResyncRetry(): void {
  if (resyncRetryTimer !== null) return
  const base = Math.min(
    RESYNC_RETRY_BASE_DELAY_MS * 2 ** Math.min(resyncRetryAttempt, 5),
    RESYNC_RETRY_MAX_DELAY_MS
  )
  // 0–25% jitter de-synchronizes several tabs retrying against the same
  // recovering server.
  const delay = base * (1 + Math.random() * 0.25)
  resyncRetryAttempt += 1
  resyncRetryTimer = setTimeout(() => {
    resyncRetryTimer = null
    if (!listenersAttached) return
    // Any fresh data (event push, later edge, manual retry) already healed
    // the snapshot — don't issue a redundant fetch.
    if (snapshot.status !== 'error') return
    legacyRefreshRequested = true
    drainLegacyRefresh()
  }, delay)
}

function createSnapshot(
  tasks: readonly DownloadTask[],
  status: TaskListStatus,
  hasReadySnapshot: boolean,
  revision: number
): TaskListAggregates {
  return Object.freeze({
    tasks,
    status,
    hasReadySnapshot,
    revision,
    retry,
    hasAnyActive: tasks.some((task) => ACTIVE_STATUSES.includes(task.status)),
    hasAnyPaused: tasks.some((task) => task.status === TaskStatus.Paused),
    hasStopped: tasks.some((task) => STOPPED_STATUSES.includes(task.status)),
  })
}

function sameTasks(
  a: readonly DownloadTask[],
  b: readonly DownloadTask[]
): boolean {
  return (
    a === b ||
    (a.length === b.length && a.every((task, index) => task === b[index]))
  )
}

function immutableTasks(
  tasks: readonly DownloadTask[]
): readonly DownloadTask[] {
  if (sameTasks(snapshot.tasks, tasks)) return snapshot.tasks
  return Object.freeze([...tasks])
}

function notify(): void {
  for (const listener of subscribers) listener()
}

function publish(options: PublishOptions): void {
  const tasks =
    options.tasks === undefined ? snapshot.tasks : immutableTasks(options.tasks)
  const status = options.status ?? snapshot.status
  const hasReadySnapshot = options.hasReadySnapshot ?? snapshot.hasReadySnapshot

  if (
    tasks === snapshot.tasks &&
    status === snapshot.status &&
    hasReadySnapshot === snapshot.hasReadySnapshot
  ) {
    return
  }

  snapshot = createSnapshot(
    tasks,
    status,
    hasReadySnapshot,
    snapshot.revision + 1
  )
  notify()
}

function canPublish(epoch: number, generation: number): boolean {
  return (
    listenersAttached &&
    lifecycleEpoch === epoch &&
    dataGeneration === generation
  )
}

function drainLegacyRefresh(): void {
  if (
    !listenersAttached ||
    !legacyRefreshRequested ||
    pendingRequest !== null
  ) {
    return
  }

  legacyRefreshRequested = false
  void requestTasks(false)
}

function requestTasks(markLoading: boolean): Promise<void> {
  if (!listenersAttached) return Promise.resolve()

  if (markLoading) publish({ status: 'loading' })

  const epoch = lifecycleEpoch
  const generation = dataGeneration
  if (
    pendingRequest?.epoch === epoch &&
    pendingRequest.generation === generation
  ) {
    return pendingRequest.promise
  }
  const request = transport
    .invoke(Queries.ListTasks)
    .then((data) => {
      if (!canPublish(epoch, generation)) return
      resetResyncRetry()
      dataGeneration += 1
      publish({
        tasks: data as readonly DownloadTask[],
        status: 'ready',
        hasReadySnapshot: true,
      })
    })
    .catch(() => {
      if (!canPublish(epoch, generation)) return
      publish({ status: 'error' })
      // Only the silent case needs self-healing: without a ready snapshot
      // the error is visible and owns a manual retry affordance.
      if (snapshot.hasReadySnapshot) scheduleResyncRetry()
    })

  // A request that never settles must not stay the pendingRequest forever:
  // treat it as a failed attempt so the coalescer and the retry loop stay
  // alive.
  const watchdog = setTimeout(() => {
    if (pendingRequest?.promise !== promise) return
    pendingRequest = null
    // Newer data (an authoritative push, a later edge) already bumped the
    // generation past this request: it is merely abandoned bookkeeping —
    // do NOT stamp 'error' over the fresh snapshot or schedule a retry.
    if (canPublish(epoch, generation)) {
      // Invalidate the hung request. Letting its LATE response publish
      // would bump the generation and evict the retry's fresher snapshot,
      // stranding an older list with no further retry.
      dataGeneration += 1
      publish({ status: 'error' })
      if (snapshot.hasReadySnapshot) scheduleResyncRetry()
    }
    drainLegacyRefresh()
  }, SNAPSHOT_DEADLINE_MS)
  const promise = request.finally(() => {
    clearTimeout(watchdog)
    if (pendingRequest?.promise !== promise) return
    pendingRequest = null
    drainLegacyRefresh()
  })
  pendingRequest = { epoch, generation, promise }
  return promise
}

function retry(): Promise<void> {
  return requestTasks(true)
}

function onTaskEvent(...args: unknown[]): void {
  const payload = args[0]
  if (Array.isArray(payload)) {
    legacyRefreshRequested = false
    resetResyncRetry()
    dataGeneration += 1
    publish({
      tasks: payload as readonly DownloadTask[],
      status: 'ready',
      hasReadySnapshot: true,
    })
    return
  }

  // Payload-less legacy events do not contain the new task list. Invalidate
  // any request that began before the event, then coalesce concurrent events
  // into one trailing fetch that necessarily starts after the latest event.
  dataGeneration += 1
  legacyRefreshRequested = true
  drainLegacyRefresh()
}

function attachListeners(): void {
  if (listenersAttached) return
  listenersAttached = true
  transport.on(Events.TaskUpdated, onTaskEvent)
  // Web transport only (Electron IPC has no renderer-owned connection
  // lifecycle, so onConnectionChange is absent there): a disconnect window
  // can swallow removal/terminal frames, and the delta-gated poll tick
  // never re-broadcasts an unchanged engine — this re-snapshot is the only
  // recovery path. requestTasks' epoch/generation guard already discards
  // stale responses racing a concurrent push. The generation bump plus the
  // legacy-refresh coalescer bound a reconnect STORM to one in-flight
  // request and one trailing request that necessarily starts after the
  // latest edge — firing one request per edge would let the generation
  // guard discard every response except the last one's, which may fail.
  detachConnectionListener =
    transport.onConnectionChange?.((event) => {
      if (event.state !== 'connected') return
      resetResyncRetry()
      dataGeneration += 1
      legacyRefreshRequested = true
      drainLegacyRefresh()
    }) ?? null
  void requestTasks(false)
}

function detachListeners(): void {
  if (!listenersAttached) return
  transport.off(Events.TaskUpdated, onTaskEvent)
  detachConnectionListener?.()
  detachConnectionListener = null
  listenersAttached = false
  lifecycleEpoch += 1
  pendingRequest = null
  legacyRefreshRequested = false
  resetResyncRetry()
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
    if (subscribers.size === 0) detachListeners()
  }, 0)
}

function subscribe(listener: StoreListener): () => void {
  cancelDeferredTeardown()
  subscribers.add(listener)
  attachListeners()

  return () => {
    subscribers.delete(listener)
    if (subscribers.size === 0) scheduleDeferredTeardown()
  }
}

function getSnapshot(): TaskListAggregates {
  return snapshot
}

const getServerSnapshot = getSnapshot

export function useTaskList(): TaskListAggregates {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** Internal: tests only. Resets the module-level external store. */
export function __resetTaskListStoreForTests(): void {
  cancelDeferredTeardown()
  detachListeners()
  subscribers.clear()
  // Keep the epoch monotonic so an unresolved promise from a previous test
  // cannot become valid again after the reset.
  lifecycleEpoch += 1
  dataGeneration = 0
  pendingRequest = null
  legacyRefreshRequested = false
  resetResyncRetry()
  snapshot = createSnapshot(EMPTY_TASKS, 'loading', false, 0)
}
