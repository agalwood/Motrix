import type Database from 'better-sqlite3'

export const TASK_DELETED_FINALIZE_REASON = 'task-deleted'

/** Deleting a task revokes recovery authority without discarding unknown bytes. */
export class FinalizeJournalLifecycle {
  private readonly deleteCleaned: Database.Statement
  private readonly cancelUnfinished: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.deleteCleaned = db.prepare(
      "DELETE FROM plugin_finalize_journals WHERE task_id=? AND phase='cleaned'"
    )
    this.cancelUnfinished = db.prepare(
      `UPDATE plugin_finalize_journals
       SET phase='quarantined', quarantine_reason=?, updated_at=?
       WHERE task_id=? AND phase <> 'cleaned' AND quarantine_reason IS NOT ?`
    )
  }

  /** Must commit or roll back together with the parent deletion. */
  cancelTask(taskId: string): void {
    if (!this.db.inTransaction)
      throw new Error('finalize cancellation requires the task transaction')
    this.deleteCleaned.run(taskId)
    // Keep the original plan, phase checkpoint and artifact identities. A
    // rollback/private path may hold the only surviving copy of user data.
    // This quarantine is terminal: neither recovery nor retry may reopen it.
    this.cancelUnfinished.run(
      TASK_DELETED_FINALIZE_REASON,
      Date.now(),
      taskId,
      TASK_DELETED_FINALIZE_REASON
    )
  }

  /** Repair journals left by older builds before either shell starts recovery. */
  cancelOrphans(): void {
    this.db.transaction(() => {
      const orphans = this.db
        .prepare(
          `SELECT task_id FROM plugin_finalize_journals AS journal
           WHERE quarantine_reason IS NOT ? AND NOT EXISTS (
             SELECT 1 FROM tasks WHERE motrix_id=journal.task_id
           )`
        )
        .all(TASK_DELETED_FINALIZE_REASON) as { task_id: string }[]
      for (const orphan of orphans) this.cancelTask(orphan.task_id)
    })()
  }
}
