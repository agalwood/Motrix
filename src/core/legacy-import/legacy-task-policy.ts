import { AppError, ErrorCode } from '@shared/errors'
import type { DownloadTask } from '@shared/types/task'

export {
  hasLegacyImport,
  isLegacyImportInactive as isInactiveLegacyTask,
} from '@shared/types/task-actions'

import { isLegacyImportInactive as isInactiveLegacyTask } from '@shared/types/task-actions'

export function assertLegacyTaskNotActivated(
  task: Pick<DownloadTask, 'instances'>
): void {
  if (isInactiveLegacyTask(task)) {
    throw new AppError(
      ErrorCode.EngineFeatureUnavailable,
      'legacyImport.activationRequired'
    )
  }
}

export function assertLegacyTaskNotRecreated(
  task: Pick<DownloadTask, 'instances'>
): void {
  if (
    (task.instances ?? []).some((instance) =>
      Object.hasOwn(instance.payload ?? {}, 'legacyImport')
    )
  )
    throw new AppError(
      ErrorCode.EngineFeatureUnavailable,
      'legacyImport.activationRequired'
    )
}

/** Pending or corrupt migration records quarantine every known reserved/bound GID. */
export function getLegacyQuarantinedGids(
  task: Pick<DownloadTask, 'instances'>
): Set<string> {
  const result = new Set<string>()
  if (!isInactiveLegacyTask(task)) return result
  for (const instance of task.instances ?? []) {
    if (instance.gid) result.add(instance.gid)
    const activation = instance.payload?.legacyBtActivation as
      | { engineTaskId?: unknown }
      | undefined
    if (
      typeof activation?.engineTaskId === 'string' &&
      /^[a-f0-9]{16}$/.test(activation.engineTaskId)
    )
      result.add(activation.engineTaskId)
  }
  return result
}
