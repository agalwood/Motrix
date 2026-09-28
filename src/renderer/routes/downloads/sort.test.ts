import {
  makeDefaultBtExtension,
  TaskStatus,
  TaskType,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import {
  nextTaskSort,
  sortTasks,
  TASK_SORT_COLUMNS,
  type TaskSortColumn,
} from './sort'

describe('download sorting', () => {
  it('defaults to newest creation time first, including tasks appended during a session', () => {
    const tasks = [
      makeDownloadTask({ id: 'old', createdAt: 1_000 }),
      makeDownloadTask({ id: 'recent', createdAt: 2_000 }),
      makeDownloadTask({ id: 'unknown' }),
    ]
    expect(sortTasks(tasks, null, 'en-US').map((task) => task.id)).toEqual([
      'recent',
      'old',
      'unknown',
    ])
    const added = makeDownloadTask({ id: 'new', createdAt: 3_000 })
    expect(
      sortTasks([...tasks, added], null, 'en-US').map((task) => task.id)
    ).toEqual(['new', 'recent', 'old', 'unknown'])
    expect(tasks.map((task) => task.id)).toEqual(['old', 'recent', 'unknown'])
  })
  it.each(['createdAt', 'finishedAt'] as const)(
    'sorts %s by the full timestamp and keeps missing dates last',
    (column) => {
      const earlier = Date.parse('2026-09-13T10:00:01Z')
      const later = Date.parse('2026-09-13T10:00:59Z')
      const tasks = [
        makeDownloadTask({ id: 'missing', status: TaskStatus.Completed }),
        makeDownloadTask({
          id: 'earlier',
          status: TaskStatus.Completed,
          [column]: earlier,
        }),
        makeDownloadTask({
          id: 'invalid',
          status: TaskStatus.Completed,
          [column]: 1e20,
        }),
        makeDownloadTask({
          id: 'later',
          status: TaskStatus.Completed,
          [column]: later,
        }),
      ]
      expect(nextTaskSort(null, column)).toEqual({ column, direction: 'desc' })
      expect(
        sortTasks(tasks, { column, direction: 'desc' }, 'en-US').map(
          (task) => task.id
        )
      ).toEqual(['later', 'earlier', 'missing', 'invalid'])
      expect(
        sortTasks(tasks, { column, direction: 'asc' }, 'en-US').map(
          (task) => task.id
        )
      ).toEqual(['earlier', 'later', 'missing', 'invalid'])
    }
  )

  it('does not rank failure or unfinished timestamps as completed tasks', () => {
    const tasks = [
      makeDownloadTask({
        id: 'error',
        status: TaskStatus.Error,
        finishedAt: 30_000,
      }),
      makeDownloadTask({ id: 'unfinished', finishedAt: 20_000 }),
      makeDownloadTask({
        id: 'completed',
        status: TaskStatus.Completed,
        finishedAt: 10_000,
      }),
    ]
    for (const direction of ['asc', 'desc'] as const) {
      expect(
        sortTasks(tasks, { column: 'finishedAt', direction }, 'en-US').map(
          (task) => task.id
        )
      ).toEqual(['completed', 'error', 'unfinished'])
    }
  })

  it.each(TASK_SORT_COLUMNS)(
    'toggles %s between two directions without clearing the sort',
    (column) => {
      const first = nextTaskSort(null, column)!
      const second = nextTaskSort(first, column)!
      expect(first.column).toBe(column)
      expect(second.column).toBe(column)
      expect(second.direction).not.toBe(first.direction)
      expect(nextTaskSort(second, column)).toEqual(first)
    }
  )

  it('starts each newly selected column in its useful direction', () => {
    expect(nextTaskSort({ column: 'name', direction: 'desc' }, 'size')).toEqual(
      { column: 'size', direction: 'desc' }
    )
    expect(nextTaskSort({ column: 'size', direction: 'asc' }, 'eta')).toEqual({
      column: 'eta',
      direction: 'asc',
    })
  })

  it('uses natural names, preserves ties, and leaves the snapshot untouched', () => {
    const tasks = Object.freeze([
      makeDownloadTask({ id: 'ten', name: 'File 10.zip' }),
      makeDownloadTask({ id: 'two', name: 'file 2.zip' }),
      makeDownloadTask({ id: 'same', name: 'FILE 2.zip' }),
    ])
    expect(
      sortTasks(tasks, { column: 'name', direction: 'asc' }, 'en-US').map(
        (task) => task.id
      )
    ).toEqual(['two', 'same', 'ten'])
    expect(
      sortTasks(tasks, { column: 'name', direction: 'desc' }, 'en-US').map(
        (task) => task.id
      )
    ).toEqual(['ten', 'two', 'same'])
    expect(sortTasks(tasks, null, 'en-US')).toEqual(tasks)
    expect(tasks.map((task) => task.id)).toEqual(['ten', 'two', 'same'])
  })

  it.each([
    'size',
    'progress',
    'down',
    'up',
    'eta',
    'connections',
  ] satisfies TaskSortColumn[])(
    'sorts %s numerically in both directions using the displayed metric',
    (column) => {
      const tasks = [
        makeDownloadTask({
          id: 'high',
          sizeWhenDone: 1_000_000,
          totalBytes: 1,
          progress: 0.805,
          downloadSpeed: 1_000_000,
          uploadSpeed: 1_000_000,
          etaSeconds: 100,
          connections: 10,
        }),
        makeDownloadTask({
          id: 'low',
          sizeWhenDone: 2_000,
          totalBytes: 10_000_000,
          progress: 0.804,
          downloadSpeed: 2_000,
          uploadSpeed: 2_000,
          etaSeconds: 2,
          connections: 2,
        }),
      ]
      expect(
        sortTasks(tasks, { column, direction: 'asc' }, 'en-US').map(
          (task) => task.id
        )
      ).toEqual(['low', 'high'])
      expect(
        sortTasks(tasks, { column, direction: 'desc' }, 'en-US').map(
          (task) => task.id
        )
      ).toEqual(['high', 'low'])
    }
  )

  it.each(['asc', 'desc'] as const)(
    'keeps hidden and invalid ETAs last in %s order',
    (direction) => {
      const missing = [
        makeDownloadTask({
          id: 'paused',
          status: TaskStatus.Paused,
          etaSeconds: 1,
        }),
        makeDownloadTask({
          id: 'complete',
          status: TaskStatus.Completed,
          etaSeconds: 1,
        }),
        makeDownloadTask({
          id: 'finalizing',
          status: TaskStatus.Finalizing,
          etaSeconds: 1,
        }),
        ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map(
          (etaSeconds, index) =>
            makeDownloadTask({ id: `unknown-${index}`, etaSeconds })
        ),
      ]
      const tasks = [
        ...missing,
        makeDownloadTask({ id: 'slow', etaSeconds: 100 }),
        makeDownloadTask({ id: 'fast', etaSeconds: 2 }),
      ]
      expect(
        sortTasks(tasks, { column: 'eta', direction }, 'en-US').map(
          (task) => task.id
        )
      ).toEqual([
        ...(direction === 'asc' ? ['fast', 'slow'] : ['slow', 'fast']),
        ...missing.map((task) => task.id),
      ])
    }
  )

  it.each(['down', 'up'] as const)(
    'keeps hidden %s speeds last in both directions',
    (column) => {
      const tasks = [
        makeDownloadTask({
          id: 'completed',
          status: TaskStatus.Completed,
          downloadSpeed: 100_000,
          uploadSpeed: 100_000,
        }),
        makeDownloadTask({ id: 'zero' }),
        makeDownloadTask({ id: 'live', downloadSpeed: 100, uploadSpeed: 100 }),
      ]
      for (const direction of ['asc', 'desc'] as const) {
        expect(
          sortTasks(tasks, { column, direction }, 'en-US').map(
            (task) => task.id
          )
        ).toEqual(['live', 'completed', 'zero'])
      }
    }
  )

  it('compares torrent peers with direct-download connections', () => {
    const tasks = [
      makeDownloadTask({
        id: 'torrent',
        type: TaskType.Bt,
        connections: 100,
        bt: makeDefaultBtExtension({ peers: 2 }),
      }),
      makeDownloadTask({ id: 'http', connections: 10 }),
      makeDownloadTask({
        id: 'magnet',
        type: TaskType.Magnet,
        connections: 100,
      }),
    ]
    expect(
      sortTasks(
        tasks,
        { column: 'connections', direction: 'desc' },
        'en-US'
      ).map((task) => task.id)
    ).toEqual(['http', 'torrent', 'magnet'])
  })

  it('groups statuses in lifecycle order', () => {
    const statuses = [
      TaskStatus.Completed,
      TaskStatus.Downloading,
      TaskStatus.Queued,
      TaskStatus.Error,
      TaskStatus.Finalizing,
      TaskStatus.Seeding,
      TaskStatus.Paused,
      TaskStatus.MetadataReady,
      TaskStatus.FetchingMetadata,
    ]
    const tasks = statuses.map((status) =>
      makeDownloadTask({ id: status, status })
    )
    const expected = [
      TaskStatus.Queued,
      TaskStatus.FetchingMetadata,
      TaskStatus.MetadataReady,
      TaskStatus.Downloading,
      TaskStatus.Finalizing,
      TaskStatus.Seeding,
      TaskStatus.Paused,
      TaskStatus.Completed,
      TaskStatus.Error,
    ]
    expect(
      sortTasks(tasks, { column: 'status', direction: 'asc' }, 'zh-CN').map(
        (task) => task.status
      )
    ).toEqual(expected)
    expect(
      sortTasks(tasks, { column: 'status', direction: 'desc' }, 'en-US').map(
        (task) => task.status
      )
    ).toEqual([...expected].reverse())
  })
})
