export type AppUpdatePhase =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
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
  availableVersion?: string
  releaseName?: string
  progress?: AppUpdateProgress
  error?: AppUpdateError
  checkedAt?: string
}
