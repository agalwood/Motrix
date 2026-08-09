export type TrackerProtocol = 'http' | 'https' | 'udp' | 'ws' | 'wss'

export interface TrackerHealth {
  url: string
  protocol: TrackerProtocol
  status: 'healthy' | 'slow' | 'unreachable' | 'unknown'
  lastProbeMs: number | null
  lastProbeAt: number | null
  successCount: number
  failCount: number
  successRate: number
}

export interface TrackerSource {
  id: string
  label: string
  url: string
  builtin: boolean
  enabled: boolean
  cdn: boolean
}

export interface CuratedTrackerList {
  effective: string[]
  blacklist: string[]
  healthMap: Record<string, TrackerHealth>
  sourceMap: Record<string, string[]>
  lastSyncAt: number | null
  lastProbeAt: number | null
}

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
