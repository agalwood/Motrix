import { describe, expect, it, vi } from 'vitest'
import {
  purgeRetiredPairTokenStorage,
  recoverStorageBeforeEndpointAutostart,
  type StorageKeyRemover,
} from '@/background/storage-migrations'

function inMemoryStorage(initial: Record<string, unknown>): {
  values: Record<string, unknown>
  remove: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
} {
  const values = { ...initial }
  return {
    values,
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]
    }),
    get: vi.fn(async () => ({})),
    set: vi.fn(async () => undefined),
  }
}

describe('purgeRetiredPairTokenStorage', () => {
  it.each([
    ['v1 map', { version: 1, tokens: { local: 'secret-sentinel' } }],
    ['future map', { version: 999, opaque: 'secret-sentinel' }],
    ['malformed map', { tokens: null }],
    ['primitive', 'secret-sentinel'],
  ])(
    'deletes both retired keys without interpreting a %s',
    async (_label, value) => {
      const storage = inMemoryStorage({
        'motrix.pairTokens': value,
        'motrix.pairToken': 'secret-sentinel',
        'motrix.mbp1.credentials': { version: 99, opaque: true },
        'another.future.key': { version: 500 },
      })

      await purgeRetiredPairTokenStorage(storage)

      expect(storage.values).toEqual({
        'motrix.mbp1.credentials': { version: 99, opaque: true },
        'another.future.key': { version: 500 },
      })
      expect(storage.remove).toHaveBeenCalledOnce()
      expect(storage.remove).toHaveBeenCalledWith([
        'motrix.pairTokens',
        'motrix.pairToken',
      ])
      expect(storage.get).not.toHaveBeenCalled()
      expect(storage.set).not.toHaveBeenCalled()
    }
  )

  it('is idempotent when both retired keys are already absent', async () => {
    const storage = inMemoryStorage({ untouched: true })

    await purgeRetiredPairTokenStorage(storage)
    await purgeRetiredPairTokenStorage(storage)

    expect(storage.values).toEqual({ untouched: true })
    expect(storage.remove).toHaveBeenCalledTimes(2)
  })

  it('propagates removal failure without reading, writing, or logging a value', async () => {
    const failure = new Error('storage remove failed')
    const remove = vi.fn(async () => {
      throw failure
    })
    const get = vi.fn(async () => ({ 'motrix.pairToken': 'secret-sentinel' }))
    const set = vi.fn(async () => undefined)
    const storage = { remove, get, set }

    await expect(
      purgeRetiredPairTokenStorage(storage as StorageKeyRemover)
    ).rejects.toBe(failure)
    expect(get).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })
})

describe('service-worker storage migration barrier', () => {
  it('does not recover endpoints until the retired namespaces are durably removed', async () => {
    const events: string[] = []
    let releaseRemove = (): void => undefined
    const removeBlocked = new Promise<void>((resolve) => {
      releaseRemove = resolve
    })
    const storage: StorageKeyRemover = {
      remove: vi.fn(async () => {
        events.push('purge-start')
        await removeBlocked
        events.push('purge-done')
      }),
    }
    const recoverPendingEndpointCleanup = vi.fn(async () => {
      events.push('recover')
    })

    const startup = recoverStorageBeforeEndpointAutostart(
      { recoverPendingEndpointCleanup },
      storage
    )
    await vi.waitFor(() => expect(events).toEqual(['purge-start']))
    expect(recoverPendingEndpointCleanup).not.toHaveBeenCalled()
    releaseRemove()
    await startup

    expect(events).toEqual(['purge-start', 'purge-done', 'recover'])
  })

  it('rejects before endpoint recovery when retired storage removal fails', async () => {
    const failure = new Error('storage unavailable')
    const storage: StorageKeyRemover = {
      remove: vi.fn(async () => {
        throw failure
      }),
    }
    const recoverPendingEndpointCleanup = vi.fn(async () => undefined)

    await expect(
      recoverStorageBeforeEndpointAutostart(
        { recoverPendingEndpointCleanup },
        storage
      )
    ).rejects.toBe(failure)
    expect(recoverPendingEndpointCleanup).not.toHaveBeenCalled()
  })

  it('rejects when interrupted endpoint cleanup cannot finish', async () => {
    const failure = new Error('authority retirement unavailable')
    const events: string[] = []
    const storage: StorageKeyRemover = {
      remove: vi.fn(async () => {
        events.push('purge')
      }),
    }
    const recoverPendingEndpointCleanup = vi.fn(async () => {
      events.push('recover')
      throw failure
    })

    await expect(
      recoverStorageBeforeEndpointAutostart(
        { recoverPendingEndpointCleanup },
        storage
      )
    ).rejects.toBe(failure)
    expect(events).toEqual(['purge', 'recover'])
  })
})
