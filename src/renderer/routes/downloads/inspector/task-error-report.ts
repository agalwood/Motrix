import {
  type FailureReasonI18n,
  resolveFailureReason,
} from '@renderer/lib/failure-reason'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'

export function taskErrorReport(
  tasks: readonly DownloadTask[],
  i18n: FailureReasonI18n
): string {
  return tasks
    .filter((task) => task.status === TaskStatus.Error)
    .map((task) => {
      const failure = resolveFailureReason(task, i18n)
      const details = [
        ...new Set(
          [
            task.errorCode,
            failure.reason,
            failure.hint,
            failure.technicalDetail,
          ].filter(Boolean)
        ),
      ].join('\n')
      return i18n.t('panel.downloads.action.errorReport', {
        name: task.name,
        id: task.id,
        details,
      })
    })
    .join('\n\n')
}
