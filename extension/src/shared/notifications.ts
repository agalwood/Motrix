export type NotifySeverity = 'confirm' | 'error' | 'reminder'

export const NOTIFICATION_KINDS = [
  'task.completed',
  'task.failed',
  'task.summary',
  'pairing.revoked',
  'connection.reminder',
  'download.feedback',
] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export interface NotificationCapability {
  available: boolean
  authorization: 'authorized' | 'notDetermined' | 'denied' | 'unavailable'
}

export type NotificationTestResult =
  | 'accepted'
  | 'suppressed'
  | 'failed'
  | 'unknown'

export interface NotificationsConfig {
  master: boolean
  confirm: boolean
  error: boolean
  reminder: boolean
}

export const NOTIFICATIONS_DEFAULT: NotificationsConfig = {
  master: true,
  confirm: false,
  error: true,
  reminder: true,
}

export function isSeverityEnabled(
  cfg: NotificationsConfig,
  severity: NotifySeverity
): boolean {
  return cfg.master && cfg[severity]
}

export interface NotifyInput {
  title: string
  message: string
  severity: NotifySeverity
  /** Business identity is independent of the user's notification category. */
  kind?: NotificationKind
  source?: NotificationSource
  deduplicationKey?: string
  deduplicationMs?: number
  failure?: {
    taskId: string
    progress?: NotificationProgressSnapshot
  }
  /** Rechecked after asynchronous preference and native capability queries. */
  isCurrent?: () => boolean
}

export interface NotificationSource {
  endpointId: string
  endpointRevision: number
  instanceId: string | null
}

export interface NotificationProgressSnapshot {
  bytesDone: number
  phase: 'queued' | 'downloading' | 'muxing' | 'finalizing'
}

export interface NotificationTaskProgress extends NotificationProgressSnapshot {
  taskId: string
  source: NotificationSource
  isCurrent?: () => boolean
}

export type Notify = ((n: NotifyInput) => void) & {
  taskProgress?: (progress: NotificationTaskProgress) => void
}
