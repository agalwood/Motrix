import type { Aria2RawStatus } from './types'

// Graceful BT shutdown can span several polls while tracker requests drain.
// Bound the optimistic state if the engine never confirms the accepted pause.
const PAUSE_SETTLE_TIMEOUT_MS = 30_000

interface PendingPause {
  expiresAt: number
  confirmedBy?: number
}

/** Reconcile accepted pauses across single queries and polling multicalls. */
export class Aria2PauseState {
  private pending = new Map<string, PendingPause>()

  clear(): void {
    this.pending.clear()
  }

  reconcile(
    method: string,
    params: unknown[],
    result: unknown,
    sequence: number
  ): unknown {
    const gid = typeof params[0] === 'string' ? params[0] : undefined
    switch (method) {
      case 'aria2.pause':
      case 'aria2.forcePause':
        if (gid && result === gid) {
          this.pending.set(gid, {
            expiresAt: performance.now() + PAUSE_SETTLE_TIMEOUT_MS,
          })
        }
        break
      case 'aria2.unpause':
      case 'aria2.remove':
      case 'aria2.forceRemove':
      case 'aria2.removeDownloadResult':
        if (gid) this.pending.delete(gid)
        break
      case 'aria2.unpauseAll':
        this.clear()
        break
      case 'aria2.tellStatus':
        return this.reconcileStatus(result, sequence, gid)
      case 'aria2.tellActive':
      case 'aria2.tellWaiting':
      case 'aria2.tellStopped':
        if (Array.isArray(result)) {
          return result.map((task) => this.reconcileStatus(task, sequence))
        }
    }
    return result
  }

  private reconcileStatus(
    result: unknown,
    sequence: number,
    requestedGid?: string
  ): unknown {
    if (!result || typeof result !== 'object') return result
    const task = result as Partial<Aria2RawStatus>
    const gid = task.gid ?? requestedGid
    if (!gid || !task.status) return result
    const pause = this.pending.get(gid)
    if (!pause) return result
    if (
      performance.now() >= pause.expiresAt ||
      task.status === 'error' ||
      task.status === 'complete' ||
      task.status === 'removed'
    ) {
      this.pending.delete(gid)
      return result
    }
    if (task.status === 'paused') {
      // Retain confirmation for older requests that are still in flight.
      pause.confirmedBy = Math.max(pause.confirmedBy ?? 0, sequence)
      return result
    }
    if (pause.confirmedBy !== undefined && sequence > pause.confirmedBy) {
      // A query newer than the confirming query can observe an external resume.
      this.pending.delete(gid)
      return result
    }

    const paused = { ...task, status: 'paused' }
    // Preserve key-filtered RPC response shapes and accumulated progress.
    for (const key of [
      'downloadSpeed',
      'uploadSpeed',
      'connections',
    ] as const) {
      if (key in task) paused[key] = '0'
    }
    return paused
  }
}
