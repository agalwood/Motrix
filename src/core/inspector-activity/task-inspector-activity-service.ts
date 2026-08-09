import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import type {
  TaskActivityCheckpoint,
  TaskActivityRevision,
  TaskHistoryEventInput,
  TaskInspectorActivitySnapshot,
  TaskTransferSample,
} from '@shared/types/task-inspector-activity'
import {
  TaskHistoryAccuracy,
  TaskTransferSampleFlag,
} from '@shared/types/task-inspector-activity'

const CHECKPOINT_INTERVAL_MS = 30_000
const PERIODIC_CANDIDATE_INTERVAL_MS = 15_000
const CHANGE_CANDIDATE_INTERVAL_MS = 5_000
const ZERO_HEARTBEAT_INTERVAL_MS = 60_000
const MAX_INTERVAL_MS = 5_000
const MAX_CLOCK_DIVERGENCE_MS = 1_000
const MATERIAL_SPEED_CHANGE = 1024 * 1024
const INTEGRATION_DENOMINATOR = 2_000_000n
const SIGNED_INT64_MAX = 9_223_372_036_854_775_807n
const MAX_PENDING_BOUNDARIES = 32
const MAX_PENDING_PROTECTED_CANDIDATES = 64

const ACTIVE_STATUSES = new Set<TaskStatus>([
  TaskStatus.FetchingMetadata,
  TaskStatus.Downloading,
  TaskStatus.Finalizing,
  TaskStatus.Seeding,
])
const DOWNLOAD_ACTIVE_STATUSES = new Set<TaskStatus>([
  TaskStatus.FetchingMetadata,
  TaskStatus.Downloading,
])
const TERMINAL_STATUSES = new Set<TaskStatus>([
  TaskStatus.Completed,
  TaskStatus.Error,
  TaskStatus.Removed,
])

export interface TaskInspectorActivityPersistence {
  ensureTask(taskId: string, now: number): void
  checkpointBatch(
    inputs: readonly TaskActivityCheckpoint[]
  ): TaskActivityCheckpointResult
  recordTransition(input: TaskHistoryEventInput): TaskActivityRevision | null
  snapshot(taskId: string): TaskInspectorActivitySnapshot | null
}

export interface TaskActivityCheckpointOmission {
  taskId: string
  error: unknown
}

export interface TaskActivityCheckpointResult {
  revisions: readonly TaskActivityRevision[]
  omissions: readonly TaskActivityCheckpointOmission[]
}

export interface TaskSamplingTransition {
  taskId: string
  previousStatus: TaskStatus
  nextStatus: TaskStatus
  occurredAt: number
  monotonicAt: number
  accuracy: TaskHistoryAccuracy
  errorCode: DownloadTask['errorCode']
  errorMessage: string | null
  errorDetailKey?: string | null
  errorDetailParams?: Record<string, string> | null
}

export interface TaskInspectorActivityServiceOptions {
  wallNow?: () => number
  monotonicNow?: () => number
  onRevision?: (revision: TaskActivityRevision) => void
  onRecoveredTransition?: (transition: TaskSamplingTransition) => void
  onError?: (
    error: unknown,
    context: { operation: string; taskId?: string }
  ) => void
}

interface Observation {
  wallMs: number
  monotonicMs: number
  status: TaskStatus
  down: number
  up: number
}

interface IntegrationState {
  taskId: string
  ensured: boolean
  baseline: Observation | null
  boundaries: TaskSamplingTransition[]
  protectedCandidates: Map<number, TaskTransferSample>
  ordinaryCandidate: TaskTransferSample | null
  activeMsDelta: number
  downloadActiveMsDelta: number
  activeUsRemainder: bigint
  downloadActiveUsRemainder: bigint
  downloadBytesDelta: bigint
  uploadBytesDelta: bigint
  downloadNumeratorRemainder: bigint
  uploadNumeratorRemainder: bigint
  committedDownloadBytes: bigint
  committedUploadBytes: bigint
  peakDownloadBps: number
  peakUploadBps: number
  rawSampleCountDelta: number
  coverageGapAt: number | null
  coverageGapNeedsCandidate: boolean
  latestPersistedWall: number
  suppressDurableUntilWall: number | null
  lastPeriodicCandidateAt: number | null
  lastHeartbeatAt: number | null
  lastChangeCandidateAt: number | null
  candidateDown: number
  candidateUp: number
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function normalizeSpeed(value: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    return null
  }
  return Math.round(value)
}

function coalesceSample(
  target: Map<number, TaskTransferSample>,
  sample: TaskTransferSample
): void {
  const existing = target.get(sample.t)
  target.set(
    sample.t,
    existing
      ? {
          ...sample,
          flags: existing.flags | sample.flags,
        }
      : sample
  )
}

export class TaskInspectorActivityService {
  private readonly wallNow: () => number
  private readonly monotonicNow: () => number
  private readonly onRevision: (revision: TaskActivityRevision) => void
  private readonly onRecoveredTransition: (
    transition: TaskSamplingTransition
  ) => void
  private readonly onError: NonNullable<
    TaskInspectorActivityServiceOptions['onError']
  >
  private readonly states = new Map<string, IntegrationState>()
  private readonly tombstones = new Set<string>()
  private lastCheckpointAttemptAt: number | null = null
  private stopped = false
  private disposePromise: Promise<void> | null = null

  constructor(
    private readonly store: TaskInspectorActivityPersistence,
    options: TaskInspectorActivityServiceOptions = {}
  ) {
    this.wallNow = options.wallNow ?? Date.now
    this.monotonicNow =
      options.monotonicNow ?? performance.now.bind(performance)
    this.onRevision = options.onRevision ?? (() => {})
    this.onRecoveredTransition = options.onRecoveredTransition ?? (() => {})
    this.onError = options.onError ?? (() => {})
  }

  recordSamples(tasks: readonly DownloadTask[]): void {
    if (this.stopped) return
    const wallMs = Math.round(this.wallNow())
    const monotonicMs = this.monotonicNow()
    if (!validTimestamp(wallMs) || !Number.isFinite(monotonicMs)) return

    for (const task of tasks) {
      if (this.tombstones.has(task.id)) continue
      try {
        this.recordSample(task, wallMs, monotonicMs)
      } catch (error) {
        this.report(error, 'record_sample', task.id)
      }
    }

    if (this.lastCheckpointAttemptAt === null) {
      this.lastCheckpointAttemptAt = monotonicMs
    } else if (
      monotonicMs - this.lastCheckpointAttemptAt >=
      CHECKPOINT_INTERVAL_MS
    ) {
      this.lastCheckpointAttemptAt = monotonicMs
      this.checkpoint()
    }
  }

  noteTransition(transition: TaskSamplingTransition): void {
    if (this.stopped || this.tombstones.has(transition.taskId)) return
    const state = this.getState(transition.taskId)
    if (transition.accuracy === TaskHistoryAccuracy.Recovered) {
      this.markGap(state, transition.occurredAt)
      state.baseline = null
      return
    }

    state.boundaries.push(transition)
    state.boundaries.sort((left, right) => left.monotonicAt - right.monotonicAt)
    if (state.boundaries.length > MAX_PENDING_BOUNDARIES) {
      const dropped = state.boundaries.shift()
      this.markGap(state, dropped?.occurredAt ?? transition.occurredAt)
    }

    if (TERMINAL_STATUSES.has(transition.nextStatus)) {
      this.closeAtExactTerminalTransition(state, transition)
    }
  }

  markDisconnected(at = Math.round(this.wallNow())): void {
    for (const state of this.states.values()) {
      this.markGap(
        state,
        validTimestamp(at) ? at : (state.baseline?.wallMs ?? 1)
      )
      state.baseline = null
      state.boundaries = []
    }
    this.checkpoint()
  }

  markParentDurable(taskId: string, at = Math.round(this.wallNow())): void {
    if (this.tombstones.has(taskId)) return
    const state = this.getState(taskId)
    this.tryEnsure(state, at)
  }

  markRecoveredAnchor(
    taskId: string,
    at = Math.round(this.wallNow())
  ): boolean {
    if (this.stopped || this.tombstones.has(taskId)) return false
    const state = this.getState(taskId)
    this.tryEnsure(state, at)
    if (!state.ensured) return false
    this.markGap(state, at)
    state.baseline = null
    state.boundaries = []
    return !this.checkpoint(taskId).includes(taskId)
  }

  tombstone(taskId: string): void {
    this.tombstones.add(taskId)
    this.states.delete(taskId)
  }

  forceCheckpoint(taskId?: string): void {
    this.checkpoint(taskId)
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.stopped = true
    this.disposePromise = Promise.resolve().then(() => {
      let pending = this.checkpoint(undefined, true)
      if (pending.length > 0) {
        pending = this.checkpoint(undefined, true)
      }
      if (pending.length > 0) {
        throw new Error(
          `Task Inspector Activity final checkpoint incomplete: ${pending.join(', ')}`
        )
      }
      this.states.clear()
    })
    return this.disposePromise
  }

  private recordSample(
    task: DownloadTask,
    wallMs: number,
    monotonicMs: number
  ): void {
    const transferActive = ACTIVE_STATUSES.has(task.status)
    const down = normalizeSpeed(transferActive ? task.downloadSpeed : 0)
    const up = normalizeSpeed(transferActive ? task.uploadSpeed : 0)
    const state = this.getState(task.id)
    this.tryEnsure(state, wallMs)
    if (down === null || up === null) {
      this.markGap(state, state.baseline?.wallMs ?? wallMs)
      state.baseline = null
      return
    }

    const current: Observation = {
      wallMs,
      monotonicMs,
      status: task.status,
      down,
      up,
    }
    const previous = state.baseline
    if (
      previous &&
      TERMINAL_STATUSES.has(previous.status) &&
      previous.status === current.status
    ) {
      // Terminal task objects can retain the engine's last non-zero speeds.
      // The terminal boundary already closed the series at zero; keep only a
      // fresh baseline so later polls cannot reopen the lifetime chart or
      // manufacture coverage gaps while the task remains terminal.
      state.baseline = current
      return
    }

    state.rawSampleCountDelta += 1
    const previousPeakDownload = state.peakDownloadBps
    const previousPeakUpload = state.peakUploadBps
    this.updatePeaks(state, current)
    const establishedNewPeak =
      state.peakDownloadBps > previousPeakDownload ||
      state.peakUploadBps > previousPeakUpload

    if (!previous) {
      // The first observation is the integration boundary. Exact transitions
      // at or before it describe unobserved time and are already reflected by
      // the task's current status; retaining them would make the next sample
      // or terminal transition look like a broken transition chain.
      state.boundaries = state.boundaries.filter(
        (boundary) => boundary.monotonicAt > current.monotonicMs
      )
      state.baseline = current
      this.addCandidate(state, { t: wallMs, down, up, flags: 0 }, true)
      this.rememberCandidateReference(state, current)
      return
    }

    if (wallMs < previous.wallMs) {
      state.suppressDurableUntilWall = Math.max(
        state.latestPersistedWall,
        previous.wallMs
      )
    }

    const elapsedWall = wallMs - previous.wallMs
    const elapsedMonotonic = monotonicMs - previous.monotonicMs
    const elapsedUs = Math.round(elapsedMonotonic * 1_000)
    if (
      elapsedUs <= 0 ||
      elapsedWall <= 0 ||
      Math.abs(elapsedWall - elapsedMonotonic) > MAX_CLOCK_DIVERGENCE_MS ||
      elapsedMonotonic > MAX_INTERVAL_MS
    ) {
      this.markGap(state, previous.wallMs)
      state.baseline = current
      this.addCandidate(state, { t: wallMs, down, up, flags: 0 }, false)
      return
    }

    const applicable: TaskSamplingTransition[] = []
    const remaining: TaskSamplingTransition[] = []
    let boundaryInvalid = false
    for (const boundary of state.boundaries) {
      if (
        boundary.monotonicAt > previous.monotonicMs &&
        boundary.monotonicAt <= monotonicMs
      ) {
        applicable.push(boundary)
      } else if (boundary.monotonicAt > monotonicMs) {
        remaining.push(boundary)
      } else {
        boundaryInvalid = true
      }
    }
    state.boundaries = remaining

    if (
      boundaryInvalid ||
      !this.boundariesMatch(previous.status, current.status, applicable)
    ) {
      this.markGap(state, previous.wallMs)
      if (applicable.length === 0 && previous.status !== current.status) {
        this.reportRecovered(previous, current, task)
      }
      state.baseline = current
      this.addCandidate(
        state,
        {
          t: wallMs,
          down,
          up,
          flags:
            previous.status === current.status
              ? 0
              : TaskTransferSampleFlag.StatusBoundary,
        },
        previous.status !== current.status
      )
      return
    }

    this.integrateInterval(state, previous, current, applicable)
    this.selectOrdinaryCandidate(state, previous, current, establishedNewPeak)
    state.baseline = current
  }

  private integrateInterval(
    state: IntegrationState,
    previous: Observation,
    current: Observation,
    boundaries: readonly TaskSamplingTransition[]
  ): void {
    let segmentStart = previous
    for (const boundary of boundaries) {
      const ratio =
        (boundary.monotonicAt - previous.monotonicMs) /
        (current.monotonicMs - previous.monotonicMs)
      const boundaryDown = Math.round(
        previous.down + (current.down - previous.down) * ratio
      )
      const boundaryUp = Math.round(
        previous.up + (current.up - previous.up) * ratio
      )
      const before: Observation = {
        wallMs: boundary.occurredAt,
        monotonicMs: boundary.monotonicAt,
        status: boundary.previousStatus,
        down: boundaryDown,
        up: boundaryUp,
      }
      this.integrateSegment(state, segmentStart, before)
      this.addCandidate(
        state,
        {
          t: boundary.occurredAt,
          down: TERMINAL_STATUSES.has(boundary.nextStatus) ? 0 : boundaryDown,
          up: TERMINAL_STATUSES.has(boundary.nextStatus) ? 0 : boundaryUp,
          flags:
            TaskTransferSampleFlag.StatusBoundary |
            (TERMINAL_STATUSES.has(boundary.nextStatus)
              ? TaskTransferSampleFlag.Terminal
              : 0),
        },
        true
      )
      segmentStart = {
        ...before,
        status: boundary.nextStatus,
      }
    }
    this.integrateSegment(state, segmentStart, current)
  }

  private closeAtExactTerminalTransition(
    state: IntegrationState,
    transition: TaskSamplingTransition
  ): void {
    const current: Observation = {
      wallMs: transition.occurredAt,
      monotonicMs: transition.monotonicAt,
      status: transition.nextStatus,
      down: 0,
      up: 0,
    }
    const previous = state.baseline
    if (!previous) {
      state.boundaries = []
      this.addTerminalCandidate(state, transition)
      state.baseline = current
      this.rememberCandidateReference(state, current)
      return
    }

    const applicable: TaskSamplingTransition[] = []
    const remaining: TaskSamplingTransition[] = []
    let boundaryInvalid = false
    for (const boundary of state.boundaries) {
      const sharesZeroLengthBoundary =
        current.monotonicMs === previous.monotonicMs &&
        boundary.monotonicAt === current.monotonicMs
      if (
        (boundary.monotonicAt > previous.monotonicMs &&
          boundary.monotonicAt <= current.monotonicMs) ||
        sharesZeroLengthBoundary
      ) {
        applicable.push(boundary)
      } else if (boundary.monotonicAt > current.monotonicMs) {
        remaining.push(boundary)
      } else {
        boundaryInvalid = true
      }
    }
    state.boundaries = remaining

    const elapsedWall = current.wallMs - previous.wallMs
    const elapsedMonotonic = current.monotonicMs - previous.monotonicMs
    const zeroLengthBoundary =
      elapsedWall === 0 &&
      elapsedMonotonic === 0 &&
      previous.status === transition.previousStatus
    const intervalValid =
      elapsedWall > 0 &&
      elapsedMonotonic > 0 &&
      Math.abs(elapsedWall - elapsedMonotonic) <= MAX_CLOCK_DIVERGENCE_MS &&
      elapsedMonotonic <= MAX_INTERVAL_MS
    const boundariesValid = this.boundariesMatch(
      previous.status,
      current.status,
      applicable
    )

    if (
      !boundaryInvalid &&
      boundariesValid &&
      (intervalValid || zeroLengthBoundary)
    ) {
      if (intervalValid) {
        this.integrateInterval(state, previous, current, applicable)
      } else {
        this.addTerminalCandidate(state, transition)
      }
    } else {
      this.markGap(state, previous.wallMs)
      this.addTerminalCandidate(state, transition)
    }

    state.baseline = current
    this.rememberCandidateReference(state, current)
  }

  private addTerminalCandidate(
    state: IntegrationState,
    transition: TaskSamplingTransition
  ): void {
    this.addCandidate(
      state,
      {
        t: transition.occurredAt,
        down: 0,
        up: 0,
        flags:
          TaskTransferSampleFlag.StatusBoundary |
          TaskTransferSampleFlag.Terminal,
      },
      true
    )
  }

  private integrateSegment(
    state: IntegrationState,
    start: Observation,
    end: Observation
  ): void {
    const elapsedUs = BigInt(
      Math.round((end.monotonicMs - start.monotonicMs) * 1_000)
    )
    if (elapsedUs <= 0n) return

    if (ACTIVE_STATUSES.has(start.status) && ACTIVE_STATUSES.has(end.status)) {
      const activeTotal = state.activeUsRemainder + elapsedUs
      state.activeMsDelta += Number(activeTotal / 1_000n)
      state.activeUsRemainder = activeTotal % 1_000n
      this.integrateDirection(state, 'upload', start.up, end.up, elapsedUs)
    }

    if (
      DOWNLOAD_ACTIVE_STATUSES.has(start.status) &&
      DOWNLOAD_ACTIVE_STATUSES.has(end.status)
    ) {
      const downloadActiveTotal = state.downloadActiveUsRemainder + elapsedUs
      state.downloadActiveMsDelta += Number(downloadActiveTotal / 1_000n)
      state.downloadActiveUsRemainder = downloadActiveTotal % 1_000n
      this.integrateDirection(
        state,
        'download',
        start.down,
        end.down,
        elapsedUs
      )
    }
  }

  private integrateDirection(
    state: IntegrationState,
    direction: 'download' | 'upload',
    startSpeed: number,
    endSpeed: number,
    elapsedUs: bigint
  ): void {
    const remainderKey =
      direction === 'download'
        ? 'downloadNumeratorRemainder'
        : 'uploadNumeratorRemainder'
    const deltaKey =
      direction === 'download' ? 'downloadBytesDelta' : 'uploadBytesDelta'
    const committed =
      direction === 'download'
        ? state.committedDownloadBytes
        : state.committedUploadBytes
    const numerator =
      (BigInt(startSpeed) + BigInt(endSpeed)) * elapsedUs + state[remainderKey]
    const wholeBytes = numerator / INTEGRATION_DENOMINATOR
    const nextRemainder = numerator % INTEGRATION_DENOMINATOR
    if (committed + state[deltaKey] + wholeBytes > SIGNED_INT64_MAX) {
      this.markGap(state, state.baseline?.wallMs ?? 1)
      return
    }
    state[deltaKey] += wholeBytes
    state[remainderKey] = nextRemainder
  }

  private selectOrdinaryCandidate(
    state: IntegrationState,
    previous: Observation,
    current: Observation,
    establishedNewPeak: boolean
  ): void {
    if (state.coverageGapNeedsCandidate) {
      this.addCandidate(
        state,
        {
          t: current.wallMs,
          down: current.down,
          up: current.up,
          flags: 0,
        },
        true
      )
      this.rememberCandidateReference(state, current)
      return
    }
    const active = ACTIVE_STATUSES.has(current.status)
    const hasTraffic = current.down > 0 || current.up > 0
    if (
      active &&
      hasTraffic &&
      (state.lastPeriodicCandidateAt === null ||
        current.monotonicMs - state.lastPeriodicCandidateAt >=
          PERIODIC_CANDIDATE_INTERVAL_MS)
    ) {
      // A checkpoint window can contain multiple periodic samples, so keep each
      // one out of the replaceable ordinary-candidate slot.
      this.addCandidate(
        state,
        {
          t: current.wallMs,
          down: current.down,
          up: current.up,
          flags: 0,
        },
        true
      )
      state.lastPeriodicCandidateAt = current.monotonicMs
      this.rememberCandidateReference(state, current)
      return
    }

    if (
      current.down === 0 &&
      current.up === 0 &&
      previous.down === 0 &&
      previous.up === 0
    ) {
      if (
        state.lastHeartbeatAt === null ||
        current.monotonicMs - state.lastHeartbeatAt >=
          ZERO_HEARTBEAT_INTERVAL_MS
      ) {
        this.addCandidate(
          state,
          { t: current.wallMs, down: 0, up: 0, flags: 0 },
          false
        )
        state.lastHeartbeatAt = current.monotonicMs
        this.rememberCandidateReference(state, current)
      }
      return
    }

    const downChange = Math.abs(current.down - state.candidateDown)
    const upChange = Math.abs(current.up - state.candidateUp)
    const material =
      (downChange >= MATERIAL_SPEED_CHANGE &&
        downChange >= state.candidateDown * 0.25) ||
      (upChange >= MATERIAL_SPEED_CHANGE &&
        upChange >= state.candidateUp * 0.25)
    if (
      (material || establishedNewPeak) &&
      (state.lastChangeCandidateAt === null ||
        current.monotonicMs - state.lastChangeCandidateAt >=
          CHANGE_CANDIDATE_INTERVAL_MS)
    ) {
      this.addCandidate(
        state,
        {
          t: current.wallMs,
          down: current.down,
          up: current.up,
          flags: 0,
        },
        false
      )
      state.lastChangeCandidateAt = current.monotonicMs
      this.rememberCandidateReference(state, current)
    }
  }

  private updatePeaks(state: IntegrationState, sample: Observation): void {
    if (DOWNLOAD_ACTIVE_STATUSES.has(sample.status)) {
      state.peakDownloadBps = Math.max(state.peakDownloadBps, sample.down)
    }
    if (ACTIVE_STATUSES.has(sample.status)) {
      state.peakUploadBps = Math.max(state.peakUploadBps, sample.up)
    }
  }

  private addCandidate(
    state: IntegrationState,
    candidate: TaskTransferSample,
    protectedCandidate: boolean
  ): void {
    if (!validTimestamp(candidate.t)) return
    if (
      state.suppressDurableUntilWall !== null &&
      candidate.t <= state.suppressDurableUntilWall
    ) {
      return
    }
    if (
      state.suppressDurableUntilWall !== null &&
      candidate.t > state.suppressDurableUntilWall
    ) {
      state.suppressDurableUntilWall = null
    }

    let next = candidate
    const hasPendingCoverageGapCandidate = [
      ...state.protectedCandidates.values(),
    ].some(
      (sample) => (sample.flags & TaskTransferSampleFlag.CoverageGap) !== 0
    )
    if (state.coverageGapNeedsCandidate && !hasPendingCoverageGapCandidate) {
      next = {
        ...candidate,
        flags: candidate.flags | TaskTransferSampleFlag.CoverageGap,
      }
      protectedCandidate = true
    }
    if (protectedCandidate || next.flags !== 0) {
      coalesceSample(state.protectedCandidates, next)
      this.boundProtectedCandidates(state)
    } else {
      state.ordinaryCandidate = next
    }
  }

  private boundProtectedCandidates(state: IntegrationState): void {
    while (state.protectedCandidates.size > MAX_PENDING_PROTECTED_CANDIDATES) {
      const ordered = [...state.protectedCandidates.values()].sort(
        (left, right) => left.t - right.t
      )
      const removable =
        ordered
          .slice(1)
          .find(
            (sample) =>
              (sample.flags &
                (TaskTransferSampleFlag.CoverageGap |
                  TaskTransferSampleFlag.Terminal)) ===
              0
          ) ?? ordered[1]
      if (!removable) return
      state.protectedCandidates.delete(removable.t)
    }
  }

  private rememberCandidateReference(
    state: IntegrationState,
    sample: Observation
  ): void {
    state.candidateDown = sample.down
    state.candidateUp = sample.up
    if (sample.down === 0 && sample.up === 0) {
      state.lastHeartbeatAt = sample.monotonicMs
    }
    if (ACTIVE_STATUSES.has(sample.status)) {
      state.lastPeriodicCandidateAt ??= sample.monotonicMs
    }
  }

  private boundariesMatch(
    initialStatus: TaskStatus,
    finalStatus: TaskStatus,
    boundaries: readonly TaskSamplingTransition[]
  ): boolean {
    let status = initialStatus
    for (const boundary of boundaries) {
      if (boundary.previousStatus !== status) return false
      status = boundary.nextStatus
    }
    return status === finalStatus
  }

  private reportRecovered(
    previous: Observation,
    current: Observation,
    task: DownloadTask
  ): void {
    try {
      this.onRecoveredTransition({
        taskId: task.id,
        previousStatus: previous.status,
        nextStatus: current.status,
        occurredAt: current.wallMs,
        monotonicAt: current.monotonicMs,
        accuracy: TaskHistoryAccuracy.Recovered,
        errorCode: task.errorCode,
        errorMessage: task.errorMessage,
        errorDetailKey: task.errorDetailKey,
        errorDetailParams: task.errorDetailParams,
      })
    } catch (error) {
      this.report(error, 'recovered_transition', task.id)
    }
  }

  private markGap(state: IntegrationState, at: number): void {
    const validAt = validTimestamp(at) ? at : 1
    state.coverageGapAt =
      state.coverageGapAt === null
        ? validAt
        : Math.min(state.coverageGapAt, validAt)
    state.coverageGapNeedsCandidate = true
  }

  private getState(taskId: string): IntegrationState {
    const existing = this.states.get(taskId)
    if (existing) return existing
    const state: IntegrationState = {
      taskId,
      ensured: false,
      baseline: null,
      boundaries: [],
      protectedCandidates: new Map(),
      ordinaryCandidate: null,
      activeMsDelta: 0,
      downloadActiveMsDelta: 0,
      activeUsRemainder: 0n,
      downloadActiveUsRemainder: 0n,
      downloadBytesDelta: 0n,
      uploadBytesDelta: 0n,
      downloadNumeratorRemainder: 0n,
      uploadNumeratorRemainder: 0n,
      committedDownloadBytes: 0n,
      committedUploadBytes: 0n,
      peakDownloadBps: 0,
      peakUploadBps: 0,
      rawSampleCountDelta: 0,
      coverageGapAt: null,
      coverageGapNeedsCandidate: false,
      latestPersistedWall: 0,
      suppressDurableUntilWall: null,
      lastPeriodicCandidateAt: null,
      lastHeartbeatAt: null,
      lastChangeCandidateAt: null,
      candidateDown: 0,
      candidateUp: 0,
    }
    this.states.set(taskId, state)
    return state
  }

  private tryEnsure(state: IntegrationState, now: number): void {
    if (state.ensured || this.tombstones.has(state.taskId)) return
    try {
      this.store.ensureTask(state.taskId, now)
      const snapshot = this.store.snapshot(state.taskId)
      if (snapshot) {
        const committedDownloadBytes = BigInt(
          snapshot.summary.estimatedDownloadBytes
        )
        const committedUploadBytes = BigInt(
          snapshot.summary.estimatedUploadBytes
        )
        const latestPersistedWall =
          snapshot.lifetime.points.at(-1)?.t ?? snapshot.summary.updatedAt
        state.committedDownloadBytes = committedDownloadBytes
        state.committedUploadBytes = committedUploadBytes
        state.peakDownloadBps = snapshot.summary.peakDownloadBps
        state.peakUploadBps = snapshot.summary.peakUploadBps
        state.latestPersistedWall = latestPersistedWall
      }
      state.ensured = true
    } catch (error) {
      this.report(error, 'ensure_task', state.taskId)
    }
  }

  private checkpoint(taskId?: string, includeRawSampleCount = false): string[] {
    const states = taskId
      ? [this.states.get(taskId)].filter((state): state is IntegrationState =>
          Boolean(state)
        )
      : [...this.states.values()]
    const selected = states.filter(
      (state) =>
        state.ensured &&
        !this.tombstones.has(state.taskId) &&
        (this.isDirty(state) ||
          (includeRawSampleCount && state.rawSampleCountDelta > 0))
    )
    if (selected.length === 0) return []

    const inputs = selected.map((state) => this.toCheckpoint(state))
    let result: TaskActivityCheckpointResult
    try {
      result = this.store.checkpointBatch(inputs)
    } catch (error) {
      this.report(error, 'checkpoint_batch')
      selected.forEach((state, index) => {
        this.markCheckpointFailure(state, inputs[index].updatedAt)
      })
      return selected.map((state) => state.taskId)
    }
    const revisions = result.revisions
    const committed = new Set(revisions.map((revision) => revision.taskId))
    const omissionErrors = new Map(
      result.omissions.map((omission) => [omission.taskId, omission.error])
    )
    const pending: string[] = []
    selected.forEach((state, index) => {
      if (committed.has(state.taskId)) {
        this.commitCheckpoint(state, inputs[index])
      } else {
        this.markCheckpointFailure(state, inputs[index].updatedAt)
        this.report(
          omissionErrors.get(state.taskId) ??
            new Error(
              `Task Inspector Activity checkpoint omitted without an error: ${state.taskId}`
            ),
          'checkpoint_task',
          state.taskId
        )
        pending.push(state.taskId)
      }
    })
    for (const revision of revisions) {
      try {
        this.onRevision(revision)
      } catch (error) {
        this.report(error, 'emit_revision', revision.taskId)
      }
    }
    return pending
  }

  private toCheckpoint(state: IntegrationState): TaskActivityCheckpoint {
    const samples = new Map<number, TaskTransferSample>(
      state.protectedCandidates
    )
    if (state.ordinaryCandidate) {
      coalesceSample(samples, state.ordinaryCandidate)
    }
    const orderedSamples = [...samples.values()].sort((a, b) => a.t - b.t)
    const observedUpdatedAt =
      orderedSamples.at(-1)?.t ??
      state.baseline?.wallMs ??
      Math.round(this.wallNow())
    return {
      taskId: state.taskId,
      updatedAt: Math.max(state.latestPersistedWall, observedUpdatedAt),
      activeMsDelta: state.activeMsDelta,
      downloadActiveMsDelta: state.downloadActiveMsDelta,
      estimatedDownloadBytesDelta: state.downloadBytesDelta,
      estimatedUploadBytesDelta: state.uploadBytesDelta,
      peakDownloadBps: state.peakDownloadBps,
      peakUploadBps: state.peakUploadBps,
      rawSampleCountDelta: state.rawSampleCountDelta,
      ...(state.coverageGapAt === null
        ? {}
        : { coverageGapAt: state.coverageGapAt }),
      samples: orderedSamples,
    }
  }

  private commitCheckpoint(
    state: IntegrationState,
    checkpoint: TaskActivityCheckpoint
  ): void {
    const committedCoverageGapCandidate = checkpoint.samples.some(
      (sample) => (sample.flags & TaskTransferSampleFlag.CoverageGap) !== 0
    )
    state.committedDownloadBytes += state.downloadBytesDelta
    state.committedUploadBytes += state.uploadBytesDelta
    state.downloadBytesDelta = 0n
    state.uploadBytesDelta = 0n
    state.activeMsDelta = 0
    state.downloadActiveMsDelta = 0
    state.rawSampleCountDelta = 0
    state.coverageGapAt = null
    if (committedCoverageGapCandidate) {
      state.coverageGapNeedsCandidate = false
    }
    for (const point of state.protectedCandidates.values()) {
      state.latestPersistedWall = Math.max(state.latestPersistedWall, point.t)
    }
    if (state.ordinaryCandidate) {
      state.latestPersistedWall = Math.max(
        state.latestPersistedWall,
        state.ordinaryCandidate.t
      )
    }
    state.latestPersistedWall = Math.max(
      state.latestPersistedWall,
      checkpoint.updatedAt
    )
    state.protectedCandidates.clear()
    state.ordinaryCandidate = null
  }

  private markCheckpointFailure(
    state: IntegrationState,
    attemptedUpdatedAt: number
  ): void {
    this.markGap(state, state.baseline?.wallMs ?? attemptedUpdatedAt)
    state.baseline = null
    state.boundaries = []
  }

  private isDirty(state: IntegrationState): boolean {
    return (
      state.activeMsDelta > 0 ||
      state.downloadActiveMsDelta > 0 ||
      state.downloadBytesDelta > 0n ||
      state.uploadBytesDelta > 0n ||
      state.coverageGapAt !== null ||
      state.protectedCandidates.size > 0 ||
      state.ordinaryCandidate !== null
    )
  }

  private report(error: unknown, operation: string, taskId?: string): void {
    try {
      this.onError(error, { operation, taskId })
    } catch {
      // Observability must not escape into polling or task lifecycle.
    }
  }
}
