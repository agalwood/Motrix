import { execFile } from 'node:child_process'
import { statfsSync } from 'node:fs'
import type { DiskProbeResult } from '@shared/types/probe'

export type ExecFn = (command: string, args: string[]) => Promise<string>

export interface CacheEntry {
  result: DiskProbeResult
  expiresAt: number
}

// Hard ceiling on a single probe subprocess (diskutil / findmnt / lsblk /
// PowerShell). Without it, a stale NFS/FUSE mount makes execFile hang forever
// — and probePrecise runs on engine startup, so the whole app would deadlock.
const EXEC_TIMEOUT_MS = 5_000

export function defaultExec(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

export function getFreeBytes(downloadPath: string): number | null {
  try {
    const stats = statfsSync(downloadPath)
    // bavail = blocks available to non-root processes. bfree includes the
    // root-reserved blocks (≈5% on ext4/XFS) the app can never use, so it
    // over-reports free space and can suppress a low-disk warning.
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}
