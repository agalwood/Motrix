import fs from 'node:fs/promises'
import path from 'node:path'
import type { FileDeletionMode } from '@shared/schemas/app-settings'
import { shell } from 'electron'
import { removePathRecursive } from './fs-helpers'

/** User-requested task cleanup. Internal temporary-file cleanup stays direct. */
export async function removeTaskPath(
  absPath: string,
  mode: FileDeletionMode
): Promise<void> {
  if (mode === 'permanent') {
    await removePathRecursive(absPath)
    return
  }

  const target = path.resolve(absPath)
  try {
    // lstat also finds broken symlinks, so trashing a link never follows it.
    await fs.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  // A failed trash operation must never fall back to permanent deletion.
  await shell.trashItem(target)
}
