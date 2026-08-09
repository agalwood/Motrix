export enum TaskActivityKind {
  Submitted = 'submitted',
  DownloadCompleted = 'download_completed',
}

export enum TaskActivityAccuracy {
  Exact = 'exact',
  Recovered = 'recovered',
}

export interface TaskActivityDayBoundary {
  dateKey: string
  fromMs: number
  toMs: number
}

export interface GetTaskActivityParams {
  days: readonly TaskActivityDayBoundary[]
}

export interface TaskActivityDay {
  dateKey: string
  submitted: number
  downloadCompleted: number
  recoveredDownloadCompleted: number
}

export interface TaskActivitySnapshot {
  generation: string
  revision: number
  coverage: {
    trackingStartedAt: number
    coverageGapAt: number | null
  }
  days: readonly TaskActivityDay[]
}

export type TaskActivityUpdatedPayload =
  | {
      type: 'inserted'
      generation: string
      revision: number
      event: {
        kind: TaskActivityKind
        occurredAt: number
        accuracy: TaskActivityAccuracy
      }
    }
  | {
      type: 'coverage_degraded'
      generation: string
      revision: number
      coverageGapAt: number
    }

export interface TaskActivityRecorder {
  recordSubmitted(input: { taskId: string; occurredAt: number }): void
  recordDownloadCompleted(input: {
    taskId: string
    occurredAt: number
    accuracy?: TaskActivityAccuracy
  }): void
}
