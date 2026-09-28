import { getLogger } from '@core/logger'
import { taskCreateRequestSchema } from '@shared/schemas/add-task'
import type { DirectoryPreferencesResult } from '@shared/schemas/directory-preferences'

/** Accepted submissions own their history write, independently of the renderer. */
export function createTaskDirectoryHistory(deps: {
  recordRecent: (path: string) => Promise<DirectoryPreferencesResult>
  runWork?: (operation: () => Promise<void>) => Promise<void>
}) {
  const log = getLogger('task-directory-history')
  const record = (path: string): void => {
    const operation = async () => {
      const result = await deps.recordRecent(path)
      if (!result.ok) {
        log.warn({ code: result.error.code }, 'Recent directory update failed')
      }
    }
    // Track desktop background work so application shutdown can drain it.
    void Promise.resolve()
      .then(() => (deps.runWork ? deps.runWork(operation) : operation()))
      .catch((err: unknown) => {
        log.warn({ err }, 'Recent directory update failed')
      })
  }

  return {
    record,
    wrap<T extends { outcome?: string; ok?: boolean }>(
      createTask: (request: unknown) => Promise<T>
    ): (request: unknown) => Promise<T> {
      return async (request) => {
        const parsed = taskCreateRequestSchema.safeParse(request)
        const result = await createTask(request)
        if (
          parsed.success &&
          (result.outcome === 'created' ||
            result.outcome === 'reused' ||
            result.outcome === 'rechecked' ||
            result.ok === true)
        ) {
          record(parsed.data.saveDir)
        }
        return result
      }
    },
  }
}
