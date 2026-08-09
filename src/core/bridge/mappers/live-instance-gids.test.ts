import type { TaskInstance } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import { liveInstanceGids } from './live-instance-gids'

function makeInstance(over: Partial<TaskInstance> = {}): TaskInstance {
  return {
    instanceId: 'inst-1',
    motrixId: 'task-1',
    gid: 'gid-1',
    phase: TaskInstancePhase.BtDownload,
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
    ...over,
  }
}

describe('liveInstanceGids', () => {
  it('returns the single gid for a single-instance task', () => {
    const task = makeDownloadTask({
      engineTaskId: 'gid-primary',
      instances: [makeInstance({ gid: 'gid-primary' })],
    })
    expect(liveInstanceGids(task)).toEqual(['gid-primary'])
  })

  it('returns every gid for a multi-instance task', () => {
    const task = makeDownloadTask({
      instances: [
        makeInstance({ instanceId: 'a', gid: 'gid-a' }),
        makeInstance({ instanceId: 'b', gid: 'gid-b' }),
      ],
    })
    expect(liveInstanceGids(task)).toEqual(['gid-a', 'gid-b'])
  })

  it('drops instances whose gid is null (not yet issued / retired)', () => {
    const task = makeDownloadTask({
      instances: [
        makeInstance({ instanceId: 'a', gid: 'gid-a' }),
        makeInstance({ instanceId: 'b', gid: null }),
        makeInstance({ instanceId: 'c', gid: 'gid-c' }),
      ],
    })
    expect(liveInstanceGids(task)).toEqual(['gid-a', 'gid-c'])
  })

  it('returns [] when no instance has a live gid', () => {
    const task = makeDownloadTask({
      instances: [makeInstance({ gid: null })],
    })
    expect(liveInstanceGids(task)).toEqual([])
  })

  it('does NOT filter by status — a paused instance keeps its gid', () => {
    // gid-presence is the liveness signal aria2 owns; status is orthogonal.
    const task = makeDownloadTask({
      instances: [
        makeInstance({ gid: 'gid-paused', status: TaskStatus.Paused }),
      ],
    })
    expect(liveInstanceGids(task)).toEqual(['gid-paused'])
  })
})
