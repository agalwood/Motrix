import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TASK_SPEED_HISTORY_MAX_POINTS,
  TaskSpeedHistoryStore,
} from './task-speed-history-store'

describe('TaskSpeedHistoryStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T12:00:00Z'))
  })

  it('records active tasks in isolated buffers', () => {
    const store = new TaskSpeedHistoryStore()
    store.append([
      makeDownloadTask({ id: 'a', downloadSpeed: 100, uploadSpeed: 10 }),
      makeDownloadTask({ id: 'b', downloadSpeed: 200, uploadSpeed: 20 }),
    ])

    expect(store.snapshot('a')).toEqual([{ t: Date.now(), down: 100, up: 10 }])
    expect(store.snapshot('b')).toEqual([{ t: Date.now(), down: 200, up: 20 }])
  })

  it('caps each task buffer at the configured maximum', () => {
    const store = new TaskSpeedHistoryStore()
    for (let i = 0; i < TASK_SPEED_HISTORY_MAX_POINTS + 5; i += 1) {
      store.append([makeDownloadTask({ id: 'a', downloadSpeed: i })])
    }

    const history = store.snapshot('a')
    expect(history).toHaveLength(TASK_SPEED_HISTORY_MAX_POINTS)
    expect(history[0]?.down).toBe(5)
    expect(history.at(-1)?.down).toBe(TASK_SPEED_HISTORY_MAX_POINTS + 4)
  })

  it('appends one zero point when recording stops and then freezes', () => {
    const store = new TaskSpeedHistoryStore()
    store.append([makeDownloadTask({ id: 'a', downloadSpeed: 100 })])
    vi.advanceTimersByTime(1_000)
    const paused = makeDownloadTask({
      id: 'a',
      status: TaskStatus.Paused,
      downloadSpeed: 0,
    })
    store.append([paused])
    store.append([paused])

    expect(store.snapshot('a')).toEqual([
      { t: Date.now() - 1_000, down: 100, up: 0 },
      { t: Date.now(), down: 0, up: 0 },
    ])
  })

  it('continues the same history when a stopped task resumes', () => {
    const store = new TaskSpeedHistoryStore()
    store.append([makeDownloadTask({ id: 'a', downloadSpeed: 100 })])
    store.append([makeDownloadTask({ id: 'a', status: TaskStatus.Paused })])
    store.append([makeDownloadTask({ id: 'a', downloadSpeed: 50 })])

    expect(store.snapshot('a').map((point) => point.down)).toEqual([100, 0, 50])
  })

  it('removes history after the task disappears and returns copies', () => {
    const store = new TaskSpeedHistoryStore()
    store.append([makeDownloadTask({ id: 'a', downloadSpeed: 100 })])
    const snapshot = store.snapshot('a')
    snapshot[0]!.down = 999
    expect(store.snapshot('a')[0]?.down).toBe(100)

    store.append([])
    expect(store.snapshot('a')).toEqual([])
  })
})
