import { TaskStatus, TaskType } from '@shared/types/task'
import { describe, expect, it } from 'vitest'
import {
  getTasksTileFixture,
  resolveTasksTileFixture,
  TASKS_TILE_FIXTURE_NAMES,
  TASKS_TILE_FIXTURES,
} from './tasks-tile.fixture'

describe('Tasks tile development fixtures', () => {
  it('exposes every required deterministic state', () => {
    expect(TASKS_TILE_FIXTURE_NAMES).toEqual([
      'active-all',
      'history',
      'loading',
      'initial-error',
      'cached-error',
      'empty',
      'offline',
      'long-content',
    ])
    expect(TASKS_TILE_FIXTURES.loading.source).toMatchObject({
      status: 'loading',
      hasReadySnapshot: false,
    })
    expect(TASKS_TILE_FIXTURES['initial-error'].source).toMatchObject({
      status: 'error',
      hasReadySnapshot: false,
    })
    expect(TASKS_TILE_FIXTURES['cached-error'].source).toMatchObject({
      status: 'error',
      hasReadySnapshot: true,
    })
    expect(TASKS_TILE_FIXTURES.offline.engineOnline).toBe(false)
    expect(
      TASKS_TILE_FIXTURES.offline.source.tasks.some(
        (task) => task.status === TaskStatus.Error
      )
    ).toBe(true)
    expect(
      TASKS_TILE_FIXTURES.offline.source.tasks.some(
        (task) => task.status === TaskStatus.Completed
      )
    ).toBe(true)
  })

  it('covers every Active status and mixed task types', () => {
    const tasks = TASKS_TILE_FIXTURES['active-all'].source.tasks
    expect(new Set(tasks.map((task) => task.status))).toEqual(
      new Set([
        TaskStatus.Queued,
        TaskStatus.FetchingMetadata,
        TaskStatus.MetadataReady,
        TaskStatus.Downloading,
        TaskStatus.Finalizing,
        TaskStatus.Seeding,
        TaskStatus.Paused,
      ])
    )
    expect(new Set(tasks.map((task) => task.type)).size).toBeGreaterThan(3)
    expect(tasks.some((task) => task.type === TaskType.Metalink)).toBe(true)
  })

  it('covers long content, missing failure copy, and large values', () => {
    const longContent = TASKS_TILE_FIXTURES['long-content'].source.tasks
    const history = TASKS_TILE_FIXTURES.history.source.tasks

    expect(longContent.some((task) => task.name.length > 100)).toBe(true)
    expect(
      history.some(
        (task) => task.status === TaskStatus.Error && !task.errorMessage
      )
    ).toBe(true)
    expect(
      history.some((task) => task.sizeWhenDone === Number.MAX_SAFE_INTEGER)
    ).toBe(true)
  })

  it('returns only named immutable fixtures', () => {
    const fixture = getTasksTileFixture('active-all')
    expect(fixture).toBe(TASKS_TILE_FIXTURES['active-all'])
    expect(Object.isFrozen(fixture)).toBe(true)
    expect(Object.isFrozen(fixture?.source.tasks)).toBe(true)
    expect(getTasksTileFixture('unknown')).toBeNull()
    expect(getTasksTileFixture(null)).toBeNull()
    expect(resolveTasksTileFixture('active-all', false)).toBeNull()
    expect(resolveTasksTileFixture('active-all', true)).toBe(fixture)
  })
})
