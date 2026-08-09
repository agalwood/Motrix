import { TaskType } from '@shared/types/task'
import { isTempPath } from './paths'

export interface FsRemover {
  removePathRecursive(absPath: string): Promise<void>
}

export interface FileCleanupService {
  cleanup(diskPath: string, taskType: TaskType): Promise<void>
}

export class FileCleanupServiceImpl implements FileCleanupService {
  constructor(private readonly fs: FsRemover) {}

  async cleanup(diskPath: string, taskType: TaskType): Promise<void> {
    // Remove the data file or container directory
    await this.fs.removePathRecursive(diskPath)

    // For HTTP/FTP tasks that still have a .motrix suffix,
    // also remove the aria2 sidecar sitting next to it.
    // BT container dir's sidecars live inside the dir and are
    // gone via recursive removal.
    if (
      (taskType === TaskType.Http || taskType === TaskType.Ftp) &&
      isTempPath(diskPath)
    ) {
      await this.fs.removePathRecursive(`${diskPath}.aria2`)
    }
  }
}
