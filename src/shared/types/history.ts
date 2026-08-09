export type HistoryStatus = 'complete' | 'error' | 'removed'

export interface HistoryFilter {
  status?: HistoryStatus
  /** Lower bound, unix milliseconds (inclusive). */
  since?: number
  /** Upper bound, unix milliseconds (inclusive). */
  until?: number
}

export interface HistorySearchQuery {
  status?: HistoryStatus[]
  since?: number
  until?: number
  infoHash?: string
  /** SQL LIKE wildcard against the file path, e.g. '%video%'. */
  pathLike?: string
  gidPrefix?: string
  minSize?: number
  maxSize?: number
}

export type RequeueStrategy =
  | 'bt-save-metadata-file'
  | 'local-metadata-file'
  | 'source-uri'
  | 'serialized-text'
  | 'synthesized-magnet'

export interface RequeueResult {
  /** New engineTaskId — fork does not reuse the historical GID. */
  newEngineTaskId: string
  strategy: RequeueStrategy
}
