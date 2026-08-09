import { describe, expect, it, vi } from 'vitest'
import { BridgeOwnership } from './bridge-ownership'

describe('BridgeOwnership', () => {
  it.each([
    ['manifest-sync', 3],
    ['endpoint-write', 4],
    ['second-ipc-handler', 6],
  ] as const)(
    'rolls every acquired post-listen resource back when %s fails',
    async (_seam, acquiredCount) => {
      const ownership = new BridgeOwnership()
      const resources = [
        'receiver',
        'listener',
        'stream',
        'endpoint',
        'ipc-1',
        'ipc-2',
      ]
      const live = new Set(resources.slice(0, acquiredCount))
      const cleaned: string[] = []
      for (const resource of resources.slice(0, acquiredCount)) {
        ownership.own(resource, () => {
          live.delete(resource)
          cleaned.push(resource)
        })
      }

      const failure = new Error(`fault:${_seam}`)
      await expect(ownership.rollback(failure)).rejects.toBe(failure)

      expect(live).toEqual(new Set())
      expect(cleaned).toEqual(resources.slice(0, acquiredCount).reverse())
      await expect(ownership.dispose()).resolves.toBeUndefined()
    }
  )

  it('attempts all rollback actions and retains the primary fault', async () => {
    const ownership = new BridgeOwnership()
    const firstCleanup = vi.fn(() => {
      throw new Error('listener close failed')
    })
    const secondCleanup = vi.fn()
    ownership.own('listener', firstCleanup)
    ownership.own('stream', secondCleanup)
    const primary = new Error('endpoint write failed')

    await expect(ownership.rollback(primary)).rejects.toSatisfy(
      (error) =>
        error instanceof AggregateError &&
        error.errors[0] === primary &&
        error.errors[1] instanceof Error
    )
    expect(firstCleanup).toHaveBeenCalledOnce()
    expect(secondCleanup).toHaveBeenCalledOnce()
  })
})
