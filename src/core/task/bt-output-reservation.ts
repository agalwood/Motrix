import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TaskType } from '@shared/types/task'
import {
  getBtDirectStorageLayout,
  getBtStorageLayout,
} from './bt-storage-layout'
import { outputPathIdentity } from './output-path-identity'

export interface BtOutputReservation {
  finalPath: string
  infoHash: string
  multiFile?: boolean
}

/** Single-file engines may read/write a sibling progress file even when metadata is separate. */
export function btOutputPaths(
  payloadPath: string,
  multiFile: boolean
): string[] {
  return multiFile ? [payloadPath] : [payloadPath, `${payloadPath}.aria2`]
}

export async function hasBtControlFile(payloadPath: string): Promise<boolean> {
  try {
    await lstat(`${payloadPath}.aria2`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Existing payload adoption/movement cannot take over another task's tree. */
export function hasReservedTaskOutput(
  tasks: readonly DownloadTask[],
  paths: readonly string[],
  excludeTaskId?: string
): boolean {
  const requested = paths.map(outputPathIdentity)
  const within = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate)
    return (
      relative === '' ||
      (relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    )
  }
  return tasks.some((task) => {
    if (task.id === excludeTaskId || task.status === TaskStatus.Removed)
      return false
    const singleFile =
      getBtDirectStorageLayout(task)?.multiFile === false ||
      getBtStorageLayout(task)?.multiFile === false ||
      task.type === TaskType.Http ||
      task.type === TaskType.Ftp
    return [
      ...[task.finalPath, task.diskPath]
        .filter(Boolean)
        .flatMap((output) => btOutputPaths(output, !singleFile)),
      ...getBtOutputReservations(task).flatMap((entry) =>
        btOutputPaths(entry.finalPath, entry.multiFile === true)
      ),
    ]
      .filter(Boolean)
      .some((output) => {
        const owned = outputPathIdentity(output)
        return requested.some(
          (candidate) => within(owned, candidate) || within(candidate, owned)
        )
      })
  })
}

/** Includes older single-reservation rows and failed attempts at other targets. */
export function getBtOutputReservations(
  task: Pick<DownloadTask, 'instances'>
): BtOutputReservation[] {
  const reservations = new Map<string, BtOutputReservation>()
  for (const instance of task.instances ?? []) {
    const payload = instance.payload ?? {}
    const values = [
      payload.btOutputReservation,
      ...(Array.isArray(payload.btOutputReservations)
        ? payload.btOutputReservations
        : []),
    ]
    for (const value of values) {
      if (!value || typeof value !== 'object') continue
      const reservation = value as Partial<BtOutputReservation>
      if (
        typeof reservation.finalPath === 'string' &&
        path.isAbsolute(reservation.finalPath) &&
        path.resolve(reservation.finalPath) !==
          path.parse(reservation.finalPath).root &&
        typeof reservation.infoHash === 'string' &&
        /^[a-f0-9]{40}$/i.test(reservation.infoHash)
      )
        reservations.set(
          reservation.finalPath,
          reservation as BtOutputReservation
        )
    }
  }
  return [...reservations.values()]
}
