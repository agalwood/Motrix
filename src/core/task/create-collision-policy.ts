import { stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { INCOMPLETE_SUFFIX } from '@shared/constants/incomplete'
import type { DownloadTask, TaskStatus } from '@shared/types/task'

/**
 * Create-collision policy for HTTP task adds: skip instead of
 * auto-renaming when the destination already exists.
 *
 * Decision table for `saveDir/<name>`:
 *   - final file exists                  -> skip (reason `final-exists`)
 *   - an ACTIVE task owns the staging `<name>.motrix` slot
 *     (task.diskPath === staging path, non-terminal status)
 *                                        -> skip (reason `active-staging`)
 *     The owner is matched against the task queue whether or not the
 *     `.motrix` file exists on disk yet, so queued / not-yet-started
 *     downloads also block duplicates.
 *   - staging exists with no active owner (stale leftover from an
 *     interrupted download)             -> delete the staging file, proceed
 *   - nothing exists                     -> proceed
 *
 * The caller (create-task-handler) turns a `skip` decision into a
 * `TaskCreateSkippedError` so the create aborts BEFORE any engine dispatch,
 * task registration, or durable persistence happens.
 */

/** Statuses that can still write to the staging file. */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'completed',
  'error',
  'removed',
] as TaskStatus[])

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export interface TaskCreateSkippedInfo {
  reason: 'final-exists' | 'active-staging'
  /** Desired final name (no incomplete suffix). */
  name: string
  /** Absolute path of the desired final file. */
  path: string
  /** Owner of the staging file when skipping due to an active task. */
  ownerTaskId: string | null
}

export class TaskCreateSkippedError extends Error {
  constructor(readonly info: TaskCreateSkippedInfo) {
    super(`task create skipped (${info.reason}): ${info.path}`)
    this.name = 'TaskCreateSkippedError'
  }
}

export interface CreateCollisionDecision {
  action: 'proceed' | 'skip'
  /** Present iff action === 'skip'. */
  reason?: TaskCreateSkippedInfo['reason']
  /** Absolute path of the desired final file. */
  finalPath: string
  /** Owner of the staging file when skipping due to an active task. */
  ownerTaskId: string | null
}

export interface CreateCollisionGuard {
  decide(input: {
    saveDir: string
    name: string
    tasks: readonly DownloadTask[]
  }): Promise<CreateCollisionDecision>
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath)
    return true
  } catch {
    return false
  }
}

/** Production guard backed by the real filesystem. */
export class FsCreateCollisionGuard implements CreateCollisionGuard {
  async decide(input: {
    saveDir: string
    name: string
    tasks: readonly DownloadTask[]
  }): Promise<CreateCollisionDecision> {
    const { saveDir, name, tasks } = input
    const finalPath = path.join(saveDir, name)

    if (await fileExists(finalPath)) {
      return {
        action: 'skip',
        reason: 'final-exists',
        finalPath,
        ownerTaskId: null,
      }
    }

    const stagingPath = finalPath + INCOMPLETE_SUFFIX
    // A non-terminal task owns this staging slot regardless of whether the
    // `.motrix` file has been created on disk yet. Queued / not-yet-started
    // tasks reserve the staging path even before aria2 opens it, so the
    // owner check must run BEFORE the on-disk check to catch duplicates
    // against the waiting queue.
    const owner = tasks.find(
      (t) => t.diskPath === stagingPath && !isTerminalTaskStatus(t.status)
    )
    if (owner) {
      return {
        action: 'skip',
        reason: 'active-staging',
        finalPath,
        ownerTaskId: owner.id,
      }
    }

    if (await fileExists(stagingPath)) {
      // Stale leftover (interrupted download whose task is terminal or
      // unknown). Remove it so the new task owns a clean slot. The
      // engine-side allow-overwrite for `.motrix` outputs is the second
      // line of defense if this unlink races or fails.
      try {
        await unlink(stagingPath)
      } catch {
        // Non-fatal: proceed - the engine-side overwrite handles it.
      }
    }

    return { action: 'proceed', finalPath, ownerTaskId: null }
  }
}