export type AppUpdatePhase =
  | 'idle'
  | 'managed'
  | 'unsupported'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'cancelled'
  | 'error'

export interface AppUpdateProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export interface AppUpdateError {
  message: string
}

/** Stable renderer-facing snapshot. Raw electron-updater payloads stay in main. */
export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  /** Absent on older hosts that predate externally managed updates. */
  updateAuthority?: 'application' | 'system'
  availableVersion?: string
  releaseName?: string
  progress?: AppUpdateProgress
  error?: AppUpdateError
  checkedAt?: string
  /** The current installer cannot safely complete an automatic installation. */
  manualInstallReason?:
    | 'portable'
    | 'cross-volume'
    | 'location-unavailable'
    | 'install-failed'
}
