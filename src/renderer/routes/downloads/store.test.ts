import type { DownloadTask } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { beforeEach, describe, expect, it } from 'vitest'
import { useDownloadsSelection } from './store'

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
