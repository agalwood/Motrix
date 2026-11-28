/** Persisted engine identity, without engine-specific session options. */
export interface EngineSessionTask {
  engineTaskId: string
  metadataTaskId: string
  sourceUri: string
  saveDir: string
  infoHash: string
}

export type EngineSessionRecoveryReason =
  | 'metadata-unavailable'
  | 'files-missing'

export interface EngineSessionTaskFailure extends EngineSessionTask {
  reason: EngineSessionRecoveryReason
}

export interface EngineSessionRecoveryStore {
  getContext(task: EngineSessionTask): {
    metadataPaths: readonly string[]
    /** A previous quarantine must survive a crash before engine-row removal. */
    retired: boolean
  }
  /** Must durably retain user-visible failures before engine rows are removed. */
  quarantine(tasks: readonly EngineSessionTaskFailure[]): Promise<void>
}
