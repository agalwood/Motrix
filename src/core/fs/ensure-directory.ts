import { mkdir, stat } from 'node:fs/promises'

/** Ensure a directory exists without trying to create an existing volume root. */
export async function ensureDirectory(directoryPath: string): Promise<void> {
  try {
    // On Windows, mkdir of an existing drive root fails with EPERM even with
    // recursive: true. Checking the directory also handles UNC/namespace roots
    // without rewriting their IO paths or suppressing permission errors.
    if ((await stat(directoryPath)).isDirectory()) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // Keep mkdir's errors for non-directory entries and inaccessible parents.
  await mkdir(directoryPath, { recursive: true })
}
