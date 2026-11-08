import type { RendererSubmission } from '@shared/schemas/renderer-submission'
import type { WindowId } from '@shared/types/window'

interface SubmissionRecord {
  id: string
  windowId: WindowId
  generation: string
  state: 'pending' | 'succeeded' | 'unknown'
  at: number
  reviewed?: boolean
}
/** Records outcomes, never arguments, credentials, torrent data or replayable calls. */
export class RendererSubmissions {
  private readonly records = new Map<string, SubmissionRecord>()
  constructor(private readonly now = () => performance.now()) {}
  async execute(
    windowId: WindowId,
    request: RendererSubmission,
    operation: () => Promise<unknown>
  ): Promise<unknown> {
    this.prune()
    if (this.records.has(request.id))
      throw new Error('Submission already accepted; inspect task state')
    // Pending calls cannot be evicted. Refuse new work before exceeding the cap.
    if (this.records.size >= 128) {
      const settled = [...this.records.values()].find(
        (record) => record.state !== 'pending'
      )
      if (!settled) throw new Error('Too many pending submissions')
      this.records.delete(settled.id)
    }
    const record: SubmissionRecord = {
      id: request.id,
      windowId,
      generation: request.generation,
      state: 'pending',
      at: this.now(),
    }
    this.records.set(request.id, record)
    try {
      const result = await operation()
      record.state = 'succeeded'
      return result
    } catch (error) {
      // A rejected batch can already have created tasks. No automatic retry.
      record.state = 'unknown'
      throw error
    } finally {
      record.at = this.now()
    }
  }
  needsReview(windowId: WindowId, generation: string): boolean {
    this.prune()
    return [...this.records.values()].some(
      (record) =>
        !record.reviewed &&
        record.windowId === windowId &&
        record.generation !== generation
    )
  }
  dismiss(windowId: WindowId): void {
    for (const record of this.records.values())
      if (record.windowId === windowId) record.reviewed = true
  }
  private prune(): void {
    const now = this.now()
    for (const [id, record] of this.records)
      if (record.state !== 'pending' && now - record.at >= 30 * 60_000)
        this.records.delete(id)
  }
}
