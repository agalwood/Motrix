import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { describe, expect, it } from 'vitest'
import { countActiveDownloads, isActiveDownload } from './active-downloads'

const task = (status: TaskStatus): DownloadTask =>
  ({ id: status, status }) as unknown as DownloadTask

describe('isActiveDownload', () => {
  it('treats FetchingMetadata, Downloading, Finalizing as active', () => {
    expect(isActiveDownload(task(TaskStatus.FetchingMetadata))).toBe(true)
    expect(isActiveDownload(task(TaskStatus.Downloading))).toBe(true)
    expect(isActiveDownload(task(TaskStatus.Finalizing))).toBe(true)
  })

  it('treats Seeding/Queued/MetadataReady/Paused/Completed/Error/Removed as inactive', () => {
    for (const s of [
      TaskStatus.Seeding,
      TaskStatus.Queued,
      TaskStatus.MetadataReady,
      TaskStatus.Paused,
      TaskStatus.Completed,
      TaskStatus.Error,
      TaskStatus.Removed,
    ]) {
      expect(isActiveDownload(task(s))).toBe(false)
    }
  })
})

describe('countActiveDownloads', () => {
  it('counts only active tasks', () => {
    const tasks = [
      task(TaskStatus.Downloading),
      task(TaskStatus.Seeding),
      task(TaskStatus.Finalizing),
      task(TaskStatus.Completed),
    ]
    expect(countActiveDownloads(tasks)).toBe(2)
  })

  it('returns 0 for an empty list', () => {
    expect(countActiveDownloads([])).toBe(0)
  })
})
