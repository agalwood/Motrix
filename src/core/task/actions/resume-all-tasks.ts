import { canResume } from '@shared/types/task-actions'
import { type BulkTaskActionResult, runBulkTaskAction } from './pause-all-tasks'
import { resumeTask } from './resume-task'
import type { TaskActionDeps } from './shared'

export async function resumeAllTasks(
  deps: TaskActionDeps
): Promise<BulkTaskActionResult> {
  return runBulkTaskAction(
    deps.taskManager
      .getAll()
      .filter(canResume)
      .map((task) => task.id),
    deps,
    resumeTask
  )
}
