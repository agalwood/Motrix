import {
  type DownloadTask,
  type TaskInstance,
  TaskInstancePhase,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import {
  pickPrimaryInstance,
  setTaskTransitionPhase,
  syncPrimaryInstanceIdentity,
  syncTerminalInstanceStatus,
} from './task-instance'

function makeInstance(overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    instanceId: 'i-1',
    motrixId: 'm-1',
    gid: 'g-1',
    phase: TaskInstancePhase.HttpDownload,
    status: TaskStatus.Downloading,
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
    ...overrides,
  }
}

describe('pickPrimaryInstance', () => {
  it('returns the only instance when array has one entry', () => {
    const only = makeInstance()
    expect(pickPrimaryInstance([only])).toBe(only)
  })

  it('returns null for empty array', () => {
    expect(pickPrimaryInstance([])).toBeNull()
  })

  it('prefers BtDownload over MagnetMetadataResolution', () => {
    const meta = makeInstance({
      instanceId: 'meta',
      phase: TaskInstancePhase.MagnetMetadataResolution,
    })
    const bt = makeInstance({
      instanceId: 'bt',
      phase: TaskInstancePhase.BtDownload,
    })
    expect(pickPrimaryInstance([meta, bt])).toBe(bt)
  })

  it('prefers FfmpegMux over HlsSegment when both exist', () => {
    const seg = makeInstance({
      instanceId: 'seg',
      phase: TaskInstancePhase.HlsSegment,
    })
    const mux = makeInstance({
      instanceId: 'mux',
      phase: TaskInstancePhase.FfmpegMux,
      gid: null,
    })
    expect(pickPrimaryInstance([seg, mux])).toBe(mux)
  })

  it('returns first instance when no phase priority differs', () => {
    const a = makeInstance({
      instanceId: 'a',
      phase: TaskInstancePhase.HlsSegment,
    })
    const b = makeInstance({
      instanceId: 'b',
      phase: TaskInstancePhase.HlsSegment,
    })
    expect(pickPrimaryInstance([a, b])).toBe(a)
  })
})

describe('durable task/instance lifecycle synchronization', () => {
  function taskWithInstances(instances: TaskInstance[]): DownloadTask {
    return makeDownloadTask({
      id: 'task-sync',
      engineTaskId: 'gid-old',
      status: TaskStatus.Finalizing,
      transitionPhase: TransitionPhase.Idle,
      instances,
    })
  }

  it('writes an aggregate transition marker to every instance', () => {
    const task = taskWithInstances([
      makeInstance({
        instanceId: 'segment',
        phase: TaskInstancePhase.HlsSegment,
      }),
      makeInstance({
        instanceId: 'mux',
        phase: TaskInstancePhase.FfmpegMux,
      }),
    ])

    setTaskTransitionPhase(task, TransitionPhase.Renaming)

    expect(task.transitionPhase).toBe(TransitionPhase.Renaming)
    expect(
      task.instances.every(
        (instance) => instance.transitionPhase === TransitionPhase.Renaming
      )
    ).toBe(true)
  })

  it('synchronizes primary gid/status and terminal status fields', () => {
    const task = taskWithInstances([
      makeInstance({
        instanceId: 'bt',
        phase: TaskInstancePhase.BtDownload,
      }),
    ])
    task.engineTaskId = 'gid-new'
    task.status = TaskStatus.Seeding

    syncPrimaryInstanceIdentity(task)
    expect(task.instances[0]).toMatchObject({
      gid: 'gid-new',
      status: TaskStatus.Seeding,
    })

    syncTerminalInstanceStatus(task, TaskStatus.Error)
    expect(task.instances[0].status).toBe(TaskStatus.Error)
  })
})
