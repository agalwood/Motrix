import { AppError, ErrorCode } from '@shared/errors'
import type { DownloadTask } from '@shared/types/task'

/** Any migration marker fails closed, including a damaged future marker. */
export function isInactiveLegacyTask(
  task: Pick<DownloadTask, 'instances'>
): boolean {
  return (task.instances ?? []).some((instance) =>
    Object.hasOwn(instance.payload ?? {}, 'legacyImport')
  )
}

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
