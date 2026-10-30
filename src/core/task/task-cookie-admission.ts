import type { DownloadCookie, EngineAdapter } from '@core/engine/engine-adapter'
import { TaskCookieError } from '@core/engine/task-cookie-error'
import { getLogger } from '@core/logger'

/** Proof that cookie validation failed before task creation acquired side effects. */
export class TaskCookieAdmissionError extends TaskCookieError {}

export function admitTaskCookies(
  adapter: EngineAdapter,
  cookies: readonly DownloadCookie[]
): void {
  try {
    adapter.validateDownloadCookies?.(cookies)
  } catch (error) {
    if (error instanceof TaskCookieError) {
      getLogger('task-cookie-admission').warn(
        { diagnostic: error.diagnostic },
        'task cookie admission rejected'
      )
      throw new TaskCookieAdmissionError(error.diagnostic)
    }
    throw error
  }
}
