import { AppError, ErrorCode } from '@shared/errors'

export interface TaskCookieDiagnostic {
  index: number
  field: string
  reason:
    | 'type'
    | 'syntax'
    | 'size'
    | 'domain'
    | 'expiry'
    | 'count'
    | 'expired'
    | 'duplicate'
    | 'noUsableCookies'
  byteLength?: number
}

/** Contains metadata only: never retain a cookie, name, value or validation input. */
export class TaskCookieError extends AppError {
  constructor(readonly diagnostic: TaskCookieDiagnostic) {
    super(ErrorCode.TaskCreateFailed, 'task.add.createFailed')
  }
}
