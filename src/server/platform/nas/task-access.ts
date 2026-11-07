import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { getBtOutputReservations } from '@core/task/bt-output-reservation'
import { pickPrimaryInstance } from '@core/task/task-instance'
import {
  type DownloadTask,
  TaskInstancePhase,
  TaskKind,
} from '@shared/types/task'
import type { ServerDownloadPathPolicy } from '../../download-path-policy'
import type { NasFiles } from './files'

/** Actual user payloads, excluding application-private metadata/media staging. */
function outputPaths(task: DownloadTask): string[] {
  const metadataOnly =
    pickPrimaryInstance(task.instances)?.phase ===
    TaskInstancePhase.MagnetMetadataResolution
  const privateStaging =
    task.kind === TaskKind.Hls || task.kind === TaskKind.Mux || metadataOnly
  return [
    ...new Set(
      [
        ...(metadataOnly ? [] : [task.finalPath]),
        ...(privateStaging ? [] : [task.diskPath]),
        ...getBtOutputReservations(task).map(
          (reservation) => reservation.finalPath
        ),
      ].filter(Boolean)
    ),
  ]
}

/** Bound at the task-action layer so Web, CLI, Extension and retry paths cannot
 * accidentally choose a transport that skips the same NAS filesystem policy. */
export class NasTaskAccess {
  constructor(
    private readonly files: Pick<
      NasFiles,
      'authorizeFile' | 'authorizeRemoval' | 'check'
    >,
    private readonly policy: ServerDownloadPathPolicy,
    private readonly ownership?: {
      checkDirectory(task: DownloadTask): Promise<void>
      checkRemoval(task: DownloadTask, path: string): Promise<void>
      checkOutput(task: DownloadTask, path: string): Promise<void>
    }
  ) {}

  readonly authorizeWrite = async (task: DownloadTask): Promise<void> => {
    await this.ownership?.checkDirectory(task)
    await this.policy.prepareSaveDir(task.saveDir)
    for (const output of outputPaths(task)) {
      await this.authorizeOutputWrite(output)
      await this.ownership?.checkOutput(task, output)
    }
  }

  readonly authorizeOutputWrite = async (output: string): Promise<void> => {
    const info = await lstat(output).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!info) {
      await this.policy.prepareSaveDir(path.dirname(output))
      return
    }
    const canonical = await this.files.authorizeFile(output, this.policy)
    await this.files.check(canonical, 'writable')
  }

  readonly authorizeRemoval = async (task: DownloadTask): Promise<void> => {
    await this.ownership?.checkDirectory(task)
    for (const output of outputPaths(task)) {
      await this.files.authorizeRemoval(output, this.policy)
      await this.ownership?.checkRemoval(task, output)
    }
  }
}
