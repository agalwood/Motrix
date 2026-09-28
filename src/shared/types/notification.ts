export type NotificationSeverity = 'info' | 'warning' | 'error'

/** Known kinds; the column is an open set — consumers must tolerate unknown strings. */
export const NotificationKinds = {
  TaskError: 'task-error',
  TaskComplete: 'task-complete',
  EngineFailure: 'engine-failure',
  EngineCompatibility: 'engine-compatibility',
  EngineRestartRequired: 'engine-restart-required',
  DnsFallback: 'dns-fallback',
} as const
export type NotificationKind = string

/** Only routine task outcomes can be hidden; application faults always pass. */
export function getHiddenNotificationKinds(preferences: {
  notifyInAppOnComplete: boolean
  notifyInAppOnError: boolean
}): string[] {
  const kinds: string[] = []
  if (!preferences.notifyInAppOnComplete)
    kinds.push(NotificationKinds.TaskComplete)
  if (!preferences.notifyInAppOnError) kinds.push(NotificationKinds.TaskError)
  return kinds
}

export interface AppNotification {
  id: string
  sourceKey: string | null
  kind: NotificationKind
  severity: NotificationSeverity
  titleKey: string
  titleParams: Record<string, string> | null
  bodyKey: string | null
  bodyParams: Record<string, string> | null
  taskId: string | null
  createdAt: number
  readAt: number | null
}
