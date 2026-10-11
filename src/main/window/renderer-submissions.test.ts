import { randomUUID } from 'node:crypto'
import { Commands } from '@shared/protocol/commands'
import { describe, expect, it, vi } from 'vitest'
import { RendererSubmissions } from './renderer-submissions'

const request = () => ({
  id: randomUUID(),
  generation: randomUUID(),
  channel: Commands.CreateTask,
  args: [],
})
describe('RendererSubmissions', () => {
  it('records admission before execution and never replays an admitted submission', async () => {
    const ledger = new RendererSubmissions()
    const req = request()
    let settle: (() => void) | undefined
    const operation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    )
    const pending = ledger.execute('add-task', req, operation)
    expect(ledger.needsReview('add-task', randomUUID())).toBe(true)
    await expect(ledger.execute('add-task', req, operation)).rejects.toThrow(
      'already accepted'
    )
    settle?.()
    await pending
    await expect(ledger.execute('add-task', req, operation)).rejects.toThrow(
      'already accepted'
    )
    expect(operation).toHaveBeenCalledOnce()
    ledger.dismiss('add-task')
    expect(ledger.needsReview('add-task', randomUUID())).toBe(false)
  })
  it('keeps ambiguous failures for review and expires only settled records', async () => {
    let now = 0
    const ledger = new RendererSubmissions(() => now)
    await expect(
      ledger.execute('add-task', request(), async () => {
        throw new Error('late failure')
      })
    ).rejects.toThrow('late failure')
    expect(ledger.needsReview('add-task', randomUUID())).toBe(true)
    now = 30 * 60_000
    expect(ledger.needsReview('add-task', randomUUID())).toBe(false)
  })
})
