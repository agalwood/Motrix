import type {
  TrackerHealth as StoredTrackerHealth,
  TrackerState,
} from '../schemas/tracker-state'

export type TrackerProtocol = 'http' | 'https' | 'udp' | 'ws' | 'wss'

export type TrackerHealth = StoredTrackerHealth

export interface TrackerSource {
  id: string
  label: string
  url: string
  builtin: boolean
  enabled: boolean
  cdn: boolean
}

type LegacyTrackerKeys =
  | 'effective'
  | 'blacklist'
  | 'healthMap'
  | 'sourceMap'
  | 'lastSyncAt'
  | 'lastProbeAt'
export type CuratedTrackerList = Pick<TrackerState, LegacyTrackerKeys> &
  Partial<Omit<TrackerState, LegacyTrackerKeys>>

export interface SyncResult {
  trackers: string[]
  sourceStatus: Record<string, SourceFetchStatus>
}

export interface SourceFetchStatus {
  ok: boolean
  count: number
  elapsedMs: number
  error?: string
  urls?: string[]
  notModified?: boolean
  etag?: string
  lastModified?: string
  retryAfterMs?: number
  failure?: 'network' | 'http' | 'invalid' | 'limit' | 'missing-cache'
}

export interface ProxyConfig {
  server: string
  username?: string
  password?: string
}

export interface SyncAndCurateResult {
  totalFetched: number
  totalHealthy: number
  totalCurated: number
  syncResult: SyncResult
}
