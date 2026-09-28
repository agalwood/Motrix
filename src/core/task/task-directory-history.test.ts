import type { DirectoryPreferencesResult } from '@shared/schemas/directory-preferences'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskDirectoryHistory } from './task-directory-history'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@core/logger', () => ({ getLogger: () => ({ warn }) }))
afterEach(() => vi.clearAllMocks())

const request = () => ({
  type: 'http',
  uris: ['https://example.com/file.zip'],
  saveDir: '/downloads ',
})
const saved: DirectoryPreferencesResult = {
  ok: true,
  value: { favorites: [], recent: [] },
}

describe('task directory history', () => {
  it.each(['created', 'reused', 'rechecked'])(
    'records the accepted %s directory snapshot without waiting for persistence',
    async (outcome) => {
      let finish!: (value: DirectoryPreferencesResult) => void
      const recordRecent = vi.fn(
        () =>
          new Promise<DirectoryPreferencesResult>((resolve) => {
            finish = resolve
          })
      )
      const work: Promise<void>[] = []
      const runWork = vi.fn((operation: () => Promise<void>) => {
        const pending = operation()
        work.push(pending)
        return pending
      })
      const history = createTaskDirectoryHistory({ recordRecent, runWork })
      const input = request()
      const result = { outcome, taskId: 'accepted' }
      const create = history.wrap(async () => {
        input.saveDir = '/changed'
        return result
      })

      await expect(create(input)).resolves.toBe(result)
      expect(recordRecent).toHaveBeenCalledExactlyOnceWith('/downloads ')
      expect(runWork).toHaveBeenCalledOnce()
      finish(saved)
      await Promise.all(work)
    }
  )

  it.each(['conflict', 'invalid-source'])(
    'does not record a %s result',
    async (outcome) => {
      const recordRecent = vi.fn()
      const create = createTaskDirectoryHistory({ recordRecent }).wrap(
        async () => ({ outcome })
      )
      await expect(create(request())).resolves.toEqual({ outcome })
      expect(recordRecent).not.toHaveBeenCalled()
    }
  )

  it('does not record a rejected task', async () => {
    const recordRecent = vi.fn()
    const create = createTaskDirectoryHistory({ recordRecent }).wrap(
      async () => {
        throw new Error('creation failed')
      }
    )
    await expect(create(request())).rejects.toThrow('creation failed')
    expect(recordRecent).not.toHaveBeenCalled()
  })

  it.each(['failure-result', 'rejection', 'synchronous-error'])(
    'keeps an accepted task successful when history returns %s',
    async (failure) => {
      const recordRecent = vi.fn(() => {
        if (failure === 'synchronous-error') throw new Error('disk failed')
        if (failure === 'rejection')
          return Promise.reject(new Error('disk failed'))
        return Promise.resolve({
          ok: false,
          error: { code: 'unavailable' },
        } as const)
      })
      const create = createTaskDirectoryHistory({ recordRecent }).wrap(
        async () => ({ outcome: 'created' })
      )
      await expect(create(request())).resolves.toEqual({ outcome: 'created' })
      await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
    }
  )
})
