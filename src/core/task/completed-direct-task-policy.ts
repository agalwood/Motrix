import {
  type DownloadTask,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'

/** Final-path RPC downloads need no rename, but still need durable retirement. */
export function isDirectFinalOutput(task: DownloadTask): boolean {
  return (
    task.kind === TaskKind.Direct &&
    (task.type === TaskType.Http || task.type === TaskType.Ftp) &&
    task.diskPath.length > 0 &&
    task.diskPath === task.finalPath &&
    task.transitionPhase === TransitionPhase.Idle &&
    task.status !== TaskStatus.Finalizing &&
    task.instances.every(
      (instance) =>
        instance.phase === TaskInstancePhase.HttpDownload &&
        (instance.gid === null || instance.gid === task.engineTaskId) &&
        instance.transitionPhase === TransitionPhase.Idle
    )
  )
}

export function isCompletedDirectOutput(task: DownloadTask): boolean {
  return task.status === TaskStatus.Completed && isDirectFinalOutput(task)
}
