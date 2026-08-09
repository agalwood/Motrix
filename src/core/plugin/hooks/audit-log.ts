import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export class HookAuditLog {
  private buffer: string[] = []
  private flushing = false
  // Promise for the in-flight flush cycle, or null when idle. drain() awaits
  // it so callers (and tests) can wait for durability instead of guessing
  // with a timer.
  private pending: Promise<void> | null = null

  constructor(private readonly file: string) {}

  async log(entry: Record<string, unknown>): Promise<void> {
    this.buffer.push(JSON.stringify({ ts: Date.now(), ...entry }))
    if (!this.flushing) {
      this.flushing = true
      // Defer to a microtask so synchronous log() calls in the same tick
      // batch into a single flush. Track the cycle so drain() can await it.
      this.pending = new Promise<void>((resolve, reject) => {
        queueMicrotask(() => this.flush().then(resolve, reject))
      })
      // Guard: if nobody calls drain(), a write failure must not surface as
      // an unhandled rejection. drain()'s own `await` still observes it.
      void this.pending.catch(() => {})
    }
  }

  /**
   * Resolves once every entry buffered so far has been written to disk.
   * Loops because a log() arriving mid-flush starts a fresh cycle. Rejects
   * if the underlying flush failed (the caller, not log(), owns that error).
   */
  async drain(): Promise<void> {
    while (this.pending) {
      const p = this.pending
      try {
        await p
      } finally {
        if (this.pending === p) this.pending = null
      }
    }
  }

  private async flush(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const data = `${this.buffer.join('\n')}\n`
    this.buffer = []
    // Clear the flag before the append await so a log() landing during the
    // write schedules a new cycle instead of being dropped.
    this.flushing = false
    await appendFile(this.file, data)
  }
}
