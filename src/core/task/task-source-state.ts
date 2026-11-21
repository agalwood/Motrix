import { sourceUrisSchema } from '@shared/schemas/task-sources'
import type { DownloadTask } from '@shared/types/task'

/** Empty is an explicit override; absence keeps the torrent's original defaults. */
export function taskWebSeeds(
  task: Pick<DownloadTask, 'bt' | 'instances' | 'engineTaskId'>
): string[] | undefined {
  const raw =
    task.bt?.webSeeds ??
    task.instances.find((instance) => instance.gid === task.engineTaskId)
      ?.payload.webSeeds
  return raw === undefined ? undefined : sourceUrisSchema.parse(raw)
}
