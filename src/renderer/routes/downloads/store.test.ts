import type { DownloadTask } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDownloadsSortStore, useDownloadsSelection } from './store'

function fakeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 't',
    engineTaskId: 'g',
    name: 'demo.iso',
    progress: 0.5,
    totalBytes: 1000,
    downloadedBytes: 500,
    saveDir: '/tmp',
    uris: ['https://example.com/demo.iso'],
    fileCount: 1,
    filename: 'demo.iso',
    sizeWhenDone: 1000,
    diskPath: '/tmp/demo.iso',
    finalPath: '/tmp/demo.iso',
    finalName: 'demo.iso',
    ...overrides,
  })
}

describe('useDownloadsSelection', () => {
  // The singleton is module-shared; reset between tests so each
  // assertion starts from a known state.
  beforeEach(() => {
    useDownloadsSelection.getState().clearSelection()
    useDownloadsSelection.getState().setItems([])
  })

  it('exposes a SelectionStore<DownloadTask> instance', () => {
    const state = useDownloadsSelection.getState()
    expect(state.selectedIds).toBeInstanceOf(Set)
    expect(state.selectedIds.size).toBe(0)
    expect(typeof state.select).toBe('function')
    expect(typeof state.toggle).toBe('function')
    expect(typeof state.setItems).toBe('function')
    expect(typeof state.rangeSelect).toBe('function')
    expect(typeof state.selectAll).toBe('function')
    expect(typeof state.clearSelection).toBe('function')
  })

  it('uses task.id as the selection key (via createSelectionStore<DownloadTask>(t => t.id))', () => {
    useDownloadsSelection
      .getState()
      .setItems([fakeTask({ id: 'task-a' }), fakeTask({ id: 'task-b' })])
    useDownloadsSelection.getState().select('task-a')
    expect(useDownloadsSelection.getState().selectedIds.has('task-a')).toBe(
      true
    )
    expect(useDownloadsSelection.getState().selectedIds.has('task-b')).toBe(
      false
    )
  })
})

describe('Downloads sort persistence', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('starts with the implicit default and restores a manual column and direction in a fresh store', () => {
    const first = createDownloadsSortStore()
    expect(first.getState().sort).toBeNull()
    first.getState().toggleSort('size')
    first.getState().toggleSort('size')
    const restored = createDownloadsSortStore()
    expect(restored.getState().sort).toEqual({
      column: 'size',
      direction: 'asc',
    })
    restored.getState().toggleSort('finishedAt')
    expect(createDownloadsSortStore().getState().sort).toEqual({
      column: 'finishedAt',
      direction: 'desc',
    })
  })

  it('removes the saved manual preference when returning to the default', () => {
    const first = createDownloadsSortStore()
    first.getState().toggleSort('name')
    first.getState().toggleSort('name')
    first.getState().resetSort()
    expect(first.getState().sort).toBeNull()
    expect(localStorage.getItem('motrix.downloads.sort')).toBeNull()
    expect(createDownloadsSortStore().getState().sort).toBeNull()
  })

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    '{"column":"obsolete","direction":"asc"}',
    '{"column":"name","direction":"sideways"}',
  ])(
    'falls back to the default for an invalid saved preference: %s',
    (saved) => {
      localStorage.setItem('motrix.downloads.sort', saved)
      const store = createDownloadsSortStore()
      expect(store.getState().sort).toBeNull()
      store.getState().toggleSort('createdAt')
      expect(createDownloadsSortStore().getState().sort).toEqual({
        column: 'createdAt',
        direction: 'asc',
      })
    }
  )

  it('keeps sorting usable when storage reads or writes are blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Blocked storage')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Blocked storage')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('Blocked storage')
    })
    const store = createDownloadsSortStore()
    expect(store.getState().sort).toBeNull()
    expect(() => store.getState().toggleSort('name')).not.toThrow()
    expect(store.getState().sort).toEqual({ column: 'name', direction: 'asc' })
    store.getState().toggleSort('name')
    expect(() => store.getState().resetSort()).not.toThrow()
    expect(store.getState().sort).toBeNull()
  })
})
