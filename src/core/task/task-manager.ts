import type { DownloadTask } from '@shared/types/task'
import { normalizeTerminalRuntimeMetrics } from './normalize-terminal-runtime-metrics'
import { collectTaskGids } from './task-instance'

const MAX_RETIRED_ENGINE_GIDS = 4_096

export class TaskManager {
  private tasks = new Map<string, DownloadTask>()
  // Secondary index: every instance gid (and the legacy engineTaskId for
  // back-compat) maps to the parent task's motrixId. Multi-instance tasks
  // (HLS, magnet metadata pending) contribute one entry per instance.
  private engineIndex = new Map<string, string>()
  private indexedGids = new Map<string, Set<string>>() // motrixId -> prior gids
  /**
   * Caller-reserved engine IDs that may already be visible to an authoritative
   * poll but do not yet have a published DownloadTask owner. Unlike retired
   * IDs, reservations are not FIFO-evicted: every entry belongs to a bounded
   * in-flight mutation and must be explicitly released or claimed by set().
   */
  private reservedEngineGids = new Set<string>()
  /**
   * Bounded process-local shield for engine rows whose ownership was explicitly
   * removed or swapped. An authoritative poll can have captured the old GID
   * immediately before that mutation; without this negative ownership record,
   * the late snapshot is indistinguishable from a genuine aria2 orphan and is
   * re-adopted under a fresh public task id.
   */
  private retiredEngineGids = new Set<string>()

  getAll(): DownloadTask[] {
    return [...this.tasks.values()]
  }

  getById(id: string): DownloadTask | undefined {
    return this.tasks.get(id)
  }

  // Drop the gid snapshot captured by the previous set(). Lifecycle code
  // mutates the stored DownloadTask object in place before persist() calls
  // set(), so the "existing" object may already contain the new gid and can
  // no longer tell us which old keys it contributed.
  private deindex(id: string): void {
    const gids = this.indexedGids.get(id)
    if (!gids) return
    for (const gid of gids) {
      // A duplicate gid may have been reassigned to another task since this
      // snapshot was captured. Never delete the newer owner's mapping.
      if (this.engineIndex.get(gid) === id) this.engineIndex.delete(gid)
    }
    this.indexedGids.delete(id)
  }

  set(id: string, task: DownloadTask): void {
    this.store(id, task, true)
  }

  /**
   * Install the durable-intent owner in the primary map and GID index while
   * keeping its reservation shield active. This lets SessionManager snapshots
   * observe the new identity before an awaited persistence barrier without
   * allowing a concurrent authoritative poll to merge a not-yet-confirmed
   * engine row. A subsequent ordinary set()/add() claims the reservation.
   */
  setReservedEngineTaskOwner(
    id: string,
    task: DownloadTask,
    engineTaskId: string
  ): void {
    if (!this.reservedEngineGids.has(engineTaskId)) {
      throw new Error(`Engine task id is not reserved: ${engineTaskId}`)
    }
    if (!collectTaskGids(task).has(engineTaskId)) {
      throw new Error(
        `Reserved engine task id is not owned by task ${id}: ${engineTaskId}`
      )
    }
    this.store(id, task, false)
  }

  /**
   * Undo a silent reserved owner before engine dispatch. The replacement and
   * reservation release happen synchronously, so neither polling nor an
   * autosave can observe an ownerless unshielded gap. Unlike post-dispatch
   * compensation, this deliberately does not consume retired-shield capacity.
   */
  rollbackReservedEngineTaskOwner(
    id: string,
    engineTaskId: string,
    replacement?: DownloadTask
  ): boolean {
    if (
      !this.reservedEngineGids.has(engineTaskId) ||
      this.engineIndex.get(engineTaskId) !== id
    ) {
      return false
    }
    this.deindex(id)
    this.tasks.delete(id)
    if (replacement) this.set(id, replacement)
    this.reservedEngineGids.delete(engineTaskId)
    return true
  }

  private store(
    id: string,
    task: DownloadTask,
    claimReservations: boolean
  ): void {
    // TaskManager is the publication boundary consumed by every shell. Keep
    // terminal snapshots internally consistent even when a lifecycle path
    // bypasses the usual action commit helpers (restore/adoption/recovery).
    normalizeTerminalRuntimeMetrics(task)

    const previousGids = new Set(this.indexedGids.get(id) ?? [])
    if (this.tasks.has(id)) this.deindex(id)

    this.tasks.set(id, task)

    const gids = collectTaskGids(task)
    for (const gid of previousGids) {
      if (!gids.has(gid)) this.retireEngineGid(gid)
    }
    for (const gid of gids) {
      // A real owner registered through set()/add() is authoritative and may
      // intentionally reclaim a caller-supplied GID.
      if (claimReservations) this.reservedEngineGids.delete(gid)
      this.retiredEngineGids.delete(gid)
      const previousOwner = this.engineIndex.get(gid)
      if (previousOwner && previousOwner !== id) {
        this.indexedGids.get(previousOwner)?.delete(gid)
      }
      this.engineIndex.set(gid, id)
    }
    if (gids.size > 0) this.indexedGids.set(id, gids)
  }

  /**
   * Register a brand-new task. Thin semantic wrapper over `set` —
   * used by createTask handlers so intent is explicit.
   */
  add(task: DownloadTask): void {
    this.set(task.id, task)
  }

  remove(id: string): boolean {
    const gids = new Set(this.indexedGids.get(id) ?? [])
    if (this.tasks.has(id)) this.deindex(id)
    for (const gid of gids) this.retireEngineGid(gid)
    return this.tasks.delete(id)
  }

  clear(): void {
    this.tasks.clear()
    this.engineIndex.clear()
    this.indexedGids.clear()
    this.reservedEngineGids.clear()
    this.retiredEngineGids.clear()
  }

  getByEngineTaskId(engineTaskId: string): DownloadTask | undefined {
    const id = this.engineIndex.get(engineTaskId)
    if (id === undefined) return undefined
    return this.tasks.get(id)
  }

  isEngineTaskIdRetired(engineTaskId: string): boolean {
    return (
      this.reservedEngineGids.has(engineTaskId) ||
      this.retiredEngineGids.has(engineTaskId)
    )
  }

  /**
   * Block orphan adoption before dispatching a caller-reserved GID to the
   * engine. A subsequent set()/add() containing the GID claims it
   * automatically. Call release only after engine non-creation or cleanup is
   * known to be complete.
   */
  reserveEngineTaskId(engineTaskId: string): void {
    if (
      engineTaskId.length === 0 ||
      this.engineIndex.has(engineTaskId) ||
      this.reservedEngineGids.has(engineTaskId) ||
      this.retiredEngineGids.has(engineTaskId)
    ) {
      throw new Error(`Engine task id is not available: ${engineTaskId}`)
    }
    this.reservedEngineGids.add(engineTaskId)
  }

  releaseEngineTaskIdReservation(engineTaskId: string): boolean {
    return this.reservedEngineGids.delete(engineTaskId)
  }

  /**
   * Complete compensation for an engine add that may have become visible.
   * A poll can have captured the row before cleanup finished, so removing the
   * reservation outright would reopen orphan adoption for that stale
   * snapshot. Move it atomically into the bounded retired shield instead.
   */
  retireEngineTaskIdReservation(engineTaskId: string): boolean {
    if (!this.reservedEngineGids.delete(engineTaskId)) return false
    this.retireEngineGid(engineTaskId)
    return true
  }

  private retireEngineGid(gid: string): void {
    if (!gid || this.retiredEngineGids.has(gid)) return
    this.retiredEngineGids.add(gid)
    while (this.retiredEngineGids.size > MAX_RETIRED_ENGINE_GIDS) {
      const oldest = this.retiredEngineGids.values().next().value
      if (oldest === undefined) return
      this.retiredEngineGids.delete(oldest)
    }
  }
}
