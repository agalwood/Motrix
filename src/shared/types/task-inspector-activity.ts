import type { SerializedByteCount, SpeedPoint } from './stats'
import type { TaskStatus } from './task'

export enum TaskHistoryEventKind {
  Added = 'added',
  Started = 'started',
  Paused = 'paused',
  Resumed = 'resumed',
  StageChanged = 'stage_changed',
  Completed = 'completed',
  Failed = 'failed',
  ObservedState = 'observed_state',
}

export enum TaskHistoryAccuracy {
  Exact = 'exact',
  Recovered = 'recovered',
}

export enum TaskHistoryDelivery {
  Initial = 'initial',
  Retry = 'retry',
}

export enum TaskInspectorActivityUpdateReason {
  Transition = 'transition',
  Checkpoint = 'checkpoint',
  CoverageDegraded = 'coverage_degraded',
}

export enum TaskTransferSampleFlag {
  StatusBoundary = 1,
  Terminal = 2,
  CoverageGap = 4,
}

export interface TaskTransferSample extends SpeedPoint {
  flags: number
}

export interface TaskHistoryEvent {
  eventOrdinal: number
  eventKey: string
  kind: TaskHistoryEventKind
  fromStatus: TaskStatus | null
  toStatus: TaskStatus
  occurredAt: number
  accuracy: TaskHistoryAccuracy
  errorCode: string | null
  errorMessage: string | null
  errorDetailKey: string | null
  errorDetailParams: Record<string, string> | null
}

/**
 * Authoritative transition input. The runtime assigns the ordinal/key pair
 * once and retains the whole value unchanged when delivery is retried.
 */
export interface TaskHistoryEventInput extends TaskHistoryEvent {
  taskId: string
  runtimeGeneration: string
  occurredMonotonicMs: number
  delivery: TaskHistoryDelivery
}

export interface TaskInspectorActivitySummary {
  trackingStartedAt: number
  coverageGapAt: number | null
  revision: number
  lastEventOrdinal: number
  activeMs: number
  downloadActiveMs: number
  estimatedDownloadBytes: SerializedByteCount
  estimatedUploadBytes: SerializedByteCount
  peakDownloadBps: number
  peakUploadBps: number
  rawSampleCount: number
  historyDroppedCount: number
  historyTruncatedAt: number | null
  updatedAt: number
}

export interface TaskInspectorActivitySnapshot {
  taskId: string
  revision: number
  summary: TaskInspectorActivitySummary
  timeline: {
    events: readonly TaskHistoryEvent[]
    trackingStartedAt: number
    coverageGapAt: number | null
    historyDroppedCount: number
    historyTruncatedAt: number | null
  }
  lifetime: {
    points: readonly TaskTransferSample[]
    averageDownloadSpeed: number
    peakDownloadSpeed: number
    peakUploadSpeed: number
    activeMs: number
    updatedAt: number
    accuracy: 'estimated'
  }
}

export interface TaskInspectorActivityUpdatedPayload {
  taskId: string
  revision: number
  reason: TaskInspectorActivityUpdateReason
}

export interface GetTaskInspectorActivityParams {
  taskId: string
}

export interface TaskActivityCheckpoint {
  taskId: string
  updatedAt: number
  activeMsDelta: number
  downloadActiveMsDelta: number
  estimatedDownloadBytesDelta: bigint
  estimatedUploadBytesDelta: bigint
  peakDownloadBps: number
  peakUploadBps: number
  rawSampleCountDelta: number
  coverageGapAt?: number
  samples: readonly TaskTransferSample[]
}

export interface TaskActivityRevision {
  taskId: string
  revision: number
  reason: TaskInspectorActivityUpdateReason
}
