import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DIRECTORY_SORT,
  DIRECTORY_SORT_STORAGE_KEY,
  DirectorySortPreferences,
  sortDirectoryEntries,
} from './directory-sort'

const entry = (name: string, modifiedAt?: number) => ({
  name,
  path: `/downloads/${name}`,
  ...(modifiedAt === undefined ? {} : { modifiedAt }),
})

describe('directory sorting', () => {
  it('sorts names naturally in both directions without changing entries or their source order', () => {
    const entries = [entry('folder10'), entry('folder2'), entry('Folder2')]
    const original = [...entries]
    const ascending = sortDirectoryEntries(entries, {
      by: 'name',
      direction: 'asc',
    })
    expect(ascending.map((value) => value.name)).toEqual([
      'Folder2',
      'folder2',
      'folder10',
    ])
    expect(
      sortDirectoryEntries(entries, { by: 'name', direction: 'desc' })
    ).toEqual([...ascending].reverse())
    expect(entries).toEqual(original)
    expect(ascending[0]).toBe(entries[2])
  })

  it('orders finite timestamps with stable name ties and unknown values last in both directions', () => {
    const entries = [
      entry('unknown10'),
      entry('zero', 0),
      entry('old', -500),
      entry('new10', 42.5),
      entry('unknown2'),
      entry('new2', 42.5),
    ]
    expect(
      sortDirectoryEntries(entries, { by: 'modified', direction: 'asc' }).map(
        (value) => value.name
      )
    ).toEqual(['old', 'zero', 'new2', 'new10', 'unknown2', 'unknown10'])
    expect(
      sortDirectoryEntries(entries, { by: 'modified', direction: 'desc' }).map(
        (value) => value.name
      )
    ).toEqual(['new2', 'new10', 'zero', 'old', 'unknown2', 'unknown10'])
  })

  it('uses paths as a deterministic final tie breaker', () => {
    const entries = [
      { name: 'same', path: '/b' },
      { name: 'same', path: '/a' },
    ]
    expect(sortDirectoryEntries(entries, DEFAULT_DIRECTORY_SORT)[0].path).toBe(
      '/a'
    )
  })
})

describe('directory sort preferences', () => {
  it.each([
    null,
    '{',
    '{}',
    '{"version":2,"by":"name","direction":"asc"}',
    '{"version":1,"by":"size","direction":"asc"}',
    '{"version":1,"by":"name","direction":"asc","path":"/secret"}',
  ])('uses defaults for missing or invalid storage: %s', (value) => {
    const storage = { getItem: () => value, setItem: vi.fn() }
    expect(new DirectorySortPreferences(() => storage).get()).toEqual(
      DEFAULT_DIRECTORY_SORT
    )
  })

  it('remembers only the version and sorting fields across page instances', () => {
    let raw: string | null = null
    const storage = {
      getItem: vi.fn(() => raw),
      setItem: vi.fn((_key: string, value: string) => {
        raw = value
      }),
    }
    const store = new DirectorySortPreferences(() => storage)
    store.set({ by: 'modified', direction: 'desc' })
    expect(storage.setItem).toHaveBeenCalledWith(
      DIRECTORY_SORT_STORAGE_KEY,
      '{"version":1,"by":"modified","direction":"desc"}'
    )
    expect(new DirectorySortPreferences(() => storage).get()).toEqual({
      by: 'modified',
      direction: 'desc',
    })
  })

  it('keeps memory authoritative after a denied write instead of rereading stale storage', () => {
    const storage = {
      getItem: vi.fn(() => '{"version":1,"by":"name","direction":"asc"}'),
      setItem: () => {
        throw new Error('Quota exceeded')
      },
    }
    const store = new DirectorySortPreferences(() => storage)
    expect(store.get()).toEqual(DEFAULT_DIRECTORY_SORT)
    store.set({ by: 'modified', direction: 'desc' })
    expect(store.get()).toEqual({ by: 'modified', direction: 'desc' })
    expect(storage.getItem).toHaveBeenCalledTimes(1)
  })

  it('keeps page-local choices when storage access itself is denied', () => {
    const store = new DirectorySortPreferences(() => {
      throw new Error('Denied')
    })
    expect(store.get()).toEqual(DEFAULT_DIRECTORY_SORT)
    store.set({ by: 'name', direction: 'desc' })
    expect(store.get()).toEqual({ by: 'name', direction: 'desc' })
  })
})
