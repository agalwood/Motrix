import type { Aria2RawStatus } from '@core/engine/aria2/types'
import { describe, expect, it, vi } from 'vitest'
import { shouldSkipForPendingMagnetMetadata } from './metadata-task-filter'

function raw(gid = 'gid-1'): Aria2RawStatus {
  return {
    gid,
    status: 'active',
    totalLength: '0',
    completedLength: '0',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    numSeeders: '0',
    seeder: 'false',
    connections: '0',
    errorCode: '',
    pieceLength: '0',
    numPieces: '0',
    dir: '/downloads',
    files: [],
  }
}

describe('shouldSkipForPendingMagnetMetadata', () => {
  it('delegates raw status observation and skips pending metadata rows', () => {
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
