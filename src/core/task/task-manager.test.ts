import type { DownloadTask, TaskInstance } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { beforeEach, describe, expect, it } from 'vitest'
import { TaskManager } from './task-manager'

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    engineTaskId: 'gid-abc',
    name: 'test.zip',
    progress: 0.5,
    totalBytes: 1000,
    downloadedBytes: 500,
    downloadSpeed: 100,
    etaSeconds: 5,
    saveDir: '/tmp',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    uris: ['http://example.com/test.zip'],
    fileCount: 1,
    connections: 1,
    filename: 'test.zip',
    sizeWhenDone: 1000,
    ...overrides,
  })
}

describe('TaskManager', () => {
  let manager: TaskManager

  beforeEach(() => {
    manager = new TaskManager()
  })

  it('set adds a task retrievable by getById', () => {
    const task = makeTask()
    manager.set('task-1', task)
    expect(manager.getById('task-1')).toBe(task)
  })

  it('set overwrites existing task', () => {
    manager.set('task-1', makeTask({ name: 'old.zip' }))
    const updated = makeTask({ name: 'new.zip' })
    manager.set('task-1', updated)
    expect(manager.getById('task-1')?.name).toBe('new.zip')
    expect(manager.getAll()).toHaveLength(1)
  })

  it.each([TaskStatus.Completed, TaskStatus.Error])(
    'set clears volatile runtime metrics for %s tasks',
    (status) => {
      const task = makeTask({
        status,
        downloadSpeed: 1_024,
        uploadSpeed: 512,
        etaSeconds: 2,
        connections: 4,
      })

      manager.set('task-1', task)

      expect(manager.getById('task-1')).toMatchObject({
        downloadSpeed: 0,
        uploadSpeed: 0,
        etaSeconds: 0,
        connections: 0,
      })
    }
  )

  it('set preserves live runtime metrics while a task is Seeding', () => {
    const task = makeTask({
      status: TaskStatus.Seeding,
      downloadSpeed: 0,
      uploadSpeed: 512,
      etaSeconds: 0,
      connections: 4,
    })

    manager.set('task-1', task)

    expect(manager.getById('task-1')).toMatchObject({
      downloadSpeed: 0,
      uploadSpeed: 512,
      etaSeconds: 0,
      connections: 4,
    })
  })

  it('remove deletes a task and returns true', () => {
    manager.set('task-1', makeTask())
    expect(manager.remove('task-1')).toBe(true)
    expect(manager.getById('task-1')).toBeUndefined()
  })

  it('remove returns false for non-existent task', () => {
    expect(manager.remove('nope')).toBe(false)
  })

  it('clear removes all tasks', () => {
    manager.set('t1', makeTask({ id: 't1' }))
    manager.set('t2', makeTask({ id: 't2' }))
    manager.clear()
    expect(manager.getAll()).toHaveLength(0)
  })

  it('getByEngineTaskId finds task by engineTaskId', () => {
    const task = makeTask({ engineTaskId: 'gid-xyz' })
    manager.set('task-1', task)
    expect(manager.getByEngineTaskId('gid-xyz')).toBe(task)
  })

  it('getByEngineTaskId returns undefined when not found', () => {
    expect(manager.getByEngineTaskId('nope')).toBeUndefined()
  })
})

describe('TaskManager — multi-instance engineIndex (Plan A Task 9)', () => {
  function makeInstance(
    instanceId: string,
    motrixId: string,
    gid: string | null,
    phase: TaskInstancePhase
  ): TaskInstance {
    return {
      instanceId,
      motrixId,
      gid,
      phase,
      status: TaskStatus.Queued,
      progress: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      uploadedBytes: 0,
      diskPath: '',
      transitionPhase: TransitionPhase.Idle,
      uris: [],
      uriHash: null,
      payload: {},
      createdAt: 0,
      updatedAt: 0,
    }
  }

  it('engineIndex maps every instance gid to the parent motrixId', () => {
    const tm = new TaskManager()
    const task: DownloadTask = makeTask({
      id: 'm-hls',
      engineTaskId: 'g-seg-0',
      kind: TaskKind.Hls,
      instances: [
        makeInstance(
          'i-seg-0',
          'm-hls',
          'g-seg-0',
          TaskInstancePhase.HlsSegment
        ),
        makeInstance(
          'i-seg-1',
          'm-hls',
          'g-seg-1',
          TaskInstancePhase.HlsSegment
        ),
        makeInstance('i-mux', 'm-hls', null, TaskInstancePhase.FfmpegMux),
      ],
    })

    tm.set(task.id, task)

    expect(tm.getByEngineTaskId('g-seg-0')?.id).toBe('m-hls')
    expect(tm.getByEngineTaskId('g-seg-1')?.id).toBe('m-hls')
    expect(tm.getByEngineTaskId('g-nonexistent')).toBeUndefined()
  })

  it('engineIndex re-syncs when a multi-instance task is updated with new gids', () => {
    const tm = new TaskManager()
    const first: DownloadTask = makeTask({
      id: 'm-x',
      engineTaskId: 'g-a',
      kind: TaskKind.Hls,
      instances: [
        makeInstance('i-a', 'm-x', 'g-a', TaskInstancePhase.HlsSegment),
        makeInstance('i-b', 'm-x', 'g-b', TaskInstancePhase.HlsSegment),
      ],
    })
    tm.set(first.id, first)

    const second: DownloadTask = makeTask({
      id: 'm-x',
      engineTaskId: 'g-c',
      kind: TaskKind.Hls,
      instances: [
        makeInstance('i-c', 'm-x', 'g-c', TaskInstancePhase.HlsSegment),
      ],
    })
    tm.set(second.id, second)

    expect(tm.getByEngineTaskId('g-a')).toBeUndefined()
    expect(tm.getByEngineTaskId('g-b')).toBeUndefined()
    expect(tm.getByEngineTaskId('g-c')?.id).toBe('m-x')
  })

  it('engineIndex removes old gids after the stored task is mutated in place', () => {
    const tm = new TaskManager()
    const task: DownloadTask = makeTask({
      id: 'm-mutated',
      engineTaskId: 'g-old',
      instances: [
        makeInstance(
          'i-old',
          'm-mutated',
          'g-old',
          TaskInstancePhase.BtDownload
        ),
      ],
    })
    tm.set(task.id, task)

    task.engineTaskId = 'g-new'
    task.instances[0].gid = 'g-new'
    tm.set(task.id, task)

    expect(tm.getByEngineTaskId('g-old')).toBeUndefined()
    expect(tm.getByEngineTaskId('g-new')).toBe(task)
  })

  it('remove() clears every instance gid from the engineIndex', () => {
    const tm = new TaskManager()
    const task: DownloadTask = makeTask({
      id: 'm-rm',
      engineTaskId: 'g-rm-0',
      kind: TaskKind.Hls,
      instances: [
        makeInstance('i-rm-0', 'm-rm', 'g-rm-0', TaskInstancePhase.HlsSegment),
        makeInstance('i-rm-1', 'm-rm', 'g-rm-1', TaskInstancePhase.HlsSegment),
      ],
    })
    tm.set(task.id, task)
    tm.remove(task.id)
    expect(tm.getByEngineTaskId('g-rm-0')).toBeUndefined()
    expect(tm.getByEngineTaskId('g-rm-1')).toBeUndefined()
  })

  it('retires every removed gid so a stale poll cannot re-adopt it as an orphan', () => {
    const tm = new TaskManager()
    const task: DownloadTask = makeTask({
      id: 'm-rm',
      engineTaskId: 'g-rm-0',
      instances: [
        makeInstance(
          'i-rm-0',
          'm-rm',
          'g-rm-0',
          TaskInstancePhase.HttpDownload
        ),
        makeInstance(
          'i-rm-1',
          'm-rm',
          'g-rm-1',
          TaskInstancePhase.HttpDownload
        ),
      ],
    })
    tm.set(task.id, task)

    tm.remove(task.id)

    expect(tm.isEngineTaskIdRetired('g-rm-0')).toBe(true)
    expect(tm.isEngineTaskIdRetired('g-rm-1')).toBe(true)
  })

  it('retires gids replaced by an atomic owner swap and releases an explicitly reclaimed gid', () => {
    const tm = new TaskManager()
    const task = makeTask({
      id: 'm-swap',
      engineTaskId: 'g-old',
      instances: [
        makeInstance(
          'i-old',
          'm-swap',
          'g-old',
          TaskInstancePhase.MagnetMetadataResolution
        ),
      ],
    })
    tm.set(task.id, task)

    task.engineTaskId = 'g-new'
    task.instances = [
      makeInstance('i-new', 'm-swap', 'g-new', TaskInstancePhase.BtDownload),
    ]
    tm.set(task.id, task)

    expect(tm.isEngineTaskIdRetired('g-old')).toBe(true)
    expect(tm.isEngineTaskIdRetired('g-new')).toBe(false)

    tm.set(
      'm-explicit-owner',
      makeTask({ id: 'm-explicit-owner', engineTaskId: 'g-old' })
    )
    expect(tm.isEngineTaskIdRetired('g-old')).toBe(false)
  })

  it('bounds retired ownership while retaining the newest stale-poll shields', () => {
    const tm = new TaskManager()
    for (let index = 0; index <= 4_096; index += 1) {
      const id = `m-${index}`
      const gid = `g-${index}`
      tm.set(id, makeTask({ id, engineTaskId: gid }))
      tm.remove(id)
    }

    expect(tm.isEngineTaskIdRetired('g-0')).toBe(false)
    expect(tm.isEngineTaskIdRetired('g-1')).toBe(true)
    expect(tm.isEngineTaskIdRetired('g-4096')).toBe(true)
  })

  it('blocks orphan adoption for a reserved gid until an owner claims or releases it', () => {
    const tm = new TaskManager()
    const reservedGid = '0123456789abcdef'

    tm.reserveEngineTaskId(reservedGid)
    expect(tm.isEngineTaskIdRetired(reservedGid)).toBe(true)
    expect(tm.getByEngineTaskId(reservedGid)).toBeUndefined()

    tm.setReservedEngineTaskOwner(
      'm-reserved-owner',
      makeTask({ id: 'm-reserved-owner', engineTaskId: reservedGid }),
      reservedGid
    )
    expect(tm.getByEngineTaskId(reservedGid)?.id).toBe('m-reserved-owner')
    expect(tm.isEngineTaskIdRetired(reservedGid)).toBe(true)

    tm.set(
      'm-reserved-owner',
      makeTask({ id: 'm-reserved-owner', engineTaskId: reservedGid })
    )
    expect(tm.isEngineTaskIdRetired(reservedGid)).toBe(false)
    expect(tm.getByEngineTaskId(reservedGid)?.id).toBe('m-reserved-owner')

    const rolledBackGid = '1111222233334444'
    tm.reserveEngineTaskId(rolledBackGid)
    tm.setReservedEngineTaskOwner(
      'm-rolled-back-owner',
      makeTask({
        id: 'm-rolled-back-owner',
        engineTaskId: rolledBackGid,
      }),
      rolledBackGid
    )
    expect(
      tm.rollbackReservedEngineTaskOwner('m-rolled-back-owner', rolledBackGid)
    ).toBe(true)
    expect(tm.getByEngineTaskId(rolledBackGid)).toBeUndefined()
    expect(tm.getById('m-rolled-back-owner')).toBeUndefined()
    expect(tm.isEngineTaskIdRetired(rolledBackGid)).toBe(false)

    const releasedGid = 'fedcba9876543210'
    tm.reserveEngineTaskId(releasedGid)
    expect(tm.releaseEngineTaskIdReservation(releasedGid)).toBe(true)
    expect(tm.isEngineTaskIdRetired(releasedGid)).toBe(false)

    const cleanedUpGid = '0011223344556677'
    tm.reserveEngineTaskId(cleanedUpGid)
    expect(tm.retireEngineTaskIdReservation(cleanedUpGid)).toBe(true)
    expect(tm.isEngineTaskIdRetired(cleanedUpGid)).toBe(true)
  })
})
