import fs from 'node:fs/promises'

/**
 * Atomic rename within the same filesystem.
 * On Unix uses rename(2); on Windows uses MoveFile (same semantics for same-volume).
 * Throws if source does not exist or if cross-filesystem operation is attempted.
 */
export async function renameAtomic(src: string, dst: string): Promise<void> {
  await fs.rename(src, dst)
}

/**
 * Remove a file or directory recursively. Idempotent — ignores ENOENT.
 */
export async function removePathRecursive(absPath: string): Promise<void> {
  await fs.rm(absPath, { recursive: true, force: true })
}
