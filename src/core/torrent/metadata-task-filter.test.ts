import { TaskStatus, TaskType } from '@shared/types/task'
import { describe, expect, it, vi } from 'vitest'
import { shouldSkipForPendingMagnetMetadata } from './metadata-task-filter'

function raw() {
  return {
    engineTaskId: 'gid-1',
    status: TaskStatus.FetchingMetadata,
    type: TaskType.Magnet,
  }
}

describe('shouldSkipForPendingMagnetMetadata', () => {
  it('delegates task observation and skips pending metadata rows', () => {
    const status = raw()
    const tracker = { observe: vi.fn(() => true) }

    expect(shouldSkipForPendingMagnetMetadata(status, tracker)).toBe(true)
    expect(tracker.observe).toHaveBeenCalledWith(status)
  })

  it('does not skip rows the tracker does not own', () => {
    const status = raw()
    const tracker = { observe: vi.fn(() => false) }

    expect(shouldSkipForPendingMagnetMetadata(status, tracker)).toBe(false)
  })

  it('does not skip when no tracker exists yet', () => {
    expect(shouldSkipForPendingMagnetMetadata(raw(), null)).toBe(false)
  })
})
