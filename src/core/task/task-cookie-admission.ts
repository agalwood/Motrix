import type { DownloadCookie, EngineAdapter } from '@core/engine/engine-adapter'
import { TaskCookieError } from '@core/engine/task-cookie-error'
import { getLogger } from '@core/logger'

/** Proof that cookie validation failed before task creation acquired side effects. */
export class TaskCookieAdmissionError extends TaskCookieError {}

export function admitTaskCookies(
  adapter: EngineAdapter,
  cookies: readonly DownloadCookie[]
): readonly DownloadCookie[] {
  try {
    const prepared = adapter.prepareDownloadCookies?.(cookies)
    if (!prepared) return structuredClone(cookies)
    if (prepared.discarded.length > 0) {
      getLogger('task-cookie-admission').warn(
        {
          inputCount: cookies.length,
          keptCount: prepared.cookies.length,
          discardedCount: prepared.discarded.length,
          diagnostics: prepared.discarded.slice(0, 20),
        },
        'task cookies adapted for the engine'
      )
    }
    return prepared.cookies
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
