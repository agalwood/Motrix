import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  type DownloadTask,
  TaskInstancePhase,
  TaskKind,
} from '@shared/types/task'
import type { ServerDownloadPathPolicy } from '../../download-path-policy'
import type { NasTaskAccess } from './task-access'

/** Recheck durable task ownership and actual engine paths before releasing a
 * paused boot. Unknown engine rows remain paused for explicit user review. */
export class NasRecoveryAccess {
  constructor(
    private readonly deps: {
      access: Pick<NasTaskAccess, 'authorizeWrite' | 'authorizeOutputWrite'>
      policy: Pick<ServerDownloadPathPolicy, 'authorizeDirectory'>
      tempDir: string
      getTask: (gid: string) => DownloadTask | undefined
      getEnginePaths: (
        gid: string
      ) => Promise<{ directory: string; files: string[] }>
    }
  ) {}

  private async metadataDirectory(
    task: DownloadTask
  ): Promise<string | undefined> {
    const instance = task.instances?.find(
      (item) => item.phase === TaskInstancePhase.MagnetMetadataResolution
    )
    if (!instance) return undefined
    const directory = instance.payload.metadataDir
    if (
      typeof directory !== 'string' ||
      path.dirname(directory) !== this.deps.tempDir ||
      !path.basename(directory).startsWith('motrix-magnet-metadata-') ||
      (await realpath(directory)) !== directory
    )
      throw new Error('Invalid metadata recovery directory')
    const info = await lstat(directory)
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0
    )
      throw new Error('Untrusted metadata recovery directory')
    return directory
  }

  readonly authorizeWrite = async (task: DownloadTask): Promise<void> => {
    await this.deps.access.authorizeWrite(task)
    await this.metadataDirectory(task)
  }

  readonly authorizeResume = async (gid: string): Promise<boolean> => {
    try {
      const task = this.deps.getTask(gid)
      if (!task || task.kind === TaskKind.Hls || task.kind === TaskKind.Mux)
        return false
      await this.authorizeWrite(task)
      const actual = await this.deps.getEnginePaths(gid)
      const metadata = await this.metadataDirectory(task)
      if (metadata) {
        if (actual.directory !== metadata) return false
        for (const file of actual.files) {
          // Metadata output must be a direct child of the protected cache.
          if (path.dirname(file) !== metadata) return false
          const info = await lstat(file).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return undefined
              throw error
            }
          )
          if (info && (!info.isFile() || info.isSymbolicLink())) return false
        }
      } else {
        await this.deps.policy.authorizeDirectory(actual.directory)
        for (const file of actual.files)
          await this.deps.access.authorizeOutputWrite(file)
      }
      return true
    } catch {
      return false
    }
  }
}
