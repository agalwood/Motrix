import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import {
  compareActiveTasks,
  compareFailedTasks,
  compareRecentTasks,
  projectTasks,
  projectTaskWindow,
  type TaskView,
  taskMatchesView,
} from './task-views'

function task(
  id: string,
  status: TaskStatus,
  overrides: Partial<DownloadTask> = {}
): DownloadTask {
  return makeDownloadTask({
    id,
    status,
    createdAt: 100,
    updatedAt: 100,
    priority: 0,
    ...overrides,
  })
}

describe('taskMatchesView', () => {
  const memberships: Record<TaskStatus, readonly TaskView[]> = {
    [TaskStatus.Queued]: ['active'],
    [TaskStatus.FetchingMetadata]: ['active'],
    [TaskStatus.MetadataReady]: ['active'],
    [TaskStatus.Downloading]: ['active'],
    [TaskStatus.Finalizing]: ['active'],
    [TaskStatus.Seeding]: ['active'],
    [TaskStatus.Paused]: ['active'],
    [TaskStatus.Completed]: ['recent'],
    [TaskStatus.Error]: ['failed'],
    [TaskStatus.Removed]: [],
  }

  it.each(Object.values(TaskStatus))(
    'assigns %s to exactly its declared views',
    (status) => {
      const candidate = task(status, status)
      for (const view of ['active', 'failed', 'recent'] as const) {
        expect(taskMatchesView(candidate, view)).toBe(
          memberships[status].includes(view)
        )
      }
    }
  )
})

describe('active ordering', () => {
  it('uses the exact status group order', () => {
    const rows = [
      task('paused', TaskStatus.Paused),
      task('queued', TaskStatus.Queued),
      task('seeding', TaskStatus.Seeding),
      task('finalizing', TaskStatus.Finalizing),
      task('metadata', TaskStatus.FetchingMetadata),
      task('downloading', TaskStatus.Downloading),
      task('ready', TaskStatus.MetadataReady),
    ]

    expect(projectTasks(rows, 'active').map((row) => row.id)).toEqual([
      'ready',
      'downloading',
      'metadata',
      'finalizing',
      'seeding',
      'queued',
      'paused',
    ])
  })

  it('breaks ties by priority, created time, then id', () => {
    const rows = [
      task('c', TaskStatus.Downloading, { priority: 2, createdAt: 10 }),
      task('b', TaskStatus.Downloading, { priority: 2, createdAt: 5 }),
      task('a', TaskStatus.Downloading, { priority: 2, createdAt: 5 }),
      task('d', TaskStatus.Downloading, { priority: 1, createdAt: 1 }),
    ]

    expect([...rows].sort(compareActiveTasks).map((row) => row.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
  })

  it('does not reorder when only speed or progress changes', () => {
    const first = [
      task('a', TaskStatus.Downloading, {
        downloadSpeed: 1,
        progress: 0.1,
      }),
      task('b', TaskStatus.Downloading, {
        downloadSpeed: 100,
        progress: 0.9,
      }),
    ]
    const updated = [
      { ...first[0], downloadSpeed: 500, progress: 0.8 },
      { ...first[1], downloadSpeed: 0, progress: 0.2 },
    ]

    expect(first.sort(compareActiveTasks).map((row) => row.id)).toEqual([
      'a',
      'b',
    ])
    expect(updated.sort(compareActiveTasks).map((row) => row.id)).toEqual([
      'a',
      'b',
    ])
  })
})

describe('terminal ordering', () => {
  it('orders failed tasks by terminal time, update time, then id', () => {
    const rows = [
      task('d', TaskStatus.Error, { finishedAt: null, updatedAt: 500 }),
      task('b', TaskStatus.Error, { finishedAt: 100, updatedAt: 300 }),
      task('a', TaskStatus.Error, { finishedAt: 100, updatedAt: 300 }),
      task('c', TaskStatus.Error, { finishedAt: 200, updatedAt: 1 }),
    ]

    expect([...rows].sort(compareFailedTasks).map((row) => row.id)).toEqual([
      'c',
      'a',
      'b',
      'd',
    ])
  })

  it('orders recent tasks by terminal time then id', () => {
    const rows = [
      task('c', TaskStatus.Completed, { finishedAt: Number.NaN }),
      task('b', TaskStatus.Completed, { finishedAt: 100 }),
      task('a', TaskStatus.Completed, { finishedAt: 100 }),
      task('d', TaskStatus.Completed, { finishedAt: 200 }),
    ]

    expect([...rows].sort(compareRecentTasks).map((row) => row.id)).toEqual([
      'd',
      'a',
      'b',
      'c',
    ])
  })

  it('keeps missing and invalid terminal times deterministic', () => {
    const rows = [
      task('z', TaskStatus.Error, {
        finishedAt: Number.POSITIVE_INFINITY,
        updatedAt: Number.NaN,
      }),
      task('a', TaskStatus.Error, {
        finishedAt: null,
        updatedAt: Number.NaN,
      }),
      task('known', TaskStatus.Error, {
        finishedAt: 1,
        updatedAt: 1,
      }),
    ]

    expect([...rows].sort(compareFailedTasks).map((row) => row.id)).toEqual([
      'known',
      'a',
      'z',
    ])
  })
})

describe('projectTaskWindow', () => {
  it.each(['active', 'failed', 'recent'] as const)(
    'matches the leading full projection for %s while retaining the total',
    (view) => {
      const rows = [
        task('paused', TaskStatus.Paused),
        task('complete-b', TaskStatus.Completed, { finishedAt: 20 }),
        task('failed-b', TaskStatus.Error, { finishedAt: 20 }),
        task('ready', TaskStatus.MetadataReady),
        task('complete-a', TaskStatus.Completed, { finishedAt: 30 }),
        task('failed-a', TaskStatus.Error, { finishedAt: 30 }),
        task('download', TaskStatus.Downloading),
      ]
      const full = projectTasks(rows, view)

      expect(projectTaskWindow(rows, view, 2)).toEqual({
        rows: full.slice(0, 2),
        total: full.length,
      })
    }
  )

  it('supports a zero window without losing the matching count', () => {
    const rows = [
      task('active-a', TaskStatus.Downloading),
      task('complete', TaskStatus.Completed),
      task('active-b', TaskStatus.Paused),
    ]

    expect(projectTaskWindow(rows, 'active', 0)).toEqual({
      rows: [],
      total: 2,
    })
  })
})
