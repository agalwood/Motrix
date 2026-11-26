import type { Aria2RawStatus, Aria2TaskStatus } from '@core/engine/aria2/types'
import { TaskManager } from '@core/task/task-manager'
import {
  type DownloadTask,
  makeDownloadTask,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { describe, expect, it, vi } from 'vitest'
import {
  getFollowedBtGid,
  isFollowedMagnetMetadata,
  reconcileFollowedMagnetTasks,
} from './magnet-follow-reconciler'

function makeAria2Row(
  overrides: Partial<Aria2RawStatus> & { gid: string }
): Aria2RawStatus {
  const base: Aria2RawStatus = {
    gid: overrides.gid,
    status: 'active',
    totalLength: '1024',
    completedLength: '0',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '1',
    numSeeders: '0',
    seeder: 'false',
    pieceLength: '16384',
    numPieces: '1',
    dir: '/downloads',
    files: [],
  }
  return Object.assign(base, overrides)
}

function makeMagnetTask(
  overrides: { id: string; engineTaskId: string } & Partial<
    Pick<DownloadTask, 'name' | 'filename' | 'status'>
  >
): DownloadTask {
  return makeDownloadTask({
    id: overrides.id,
    engineTaskId: overrides.engineTaskId,
    name: overrides.name ?? 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc',
    kind: TaskKind.Bt,
    type: TaskType.Magnet,
    status: overrides.status ?? TaskStatus.Queued,
    saveDir: '/downloads',
    filename: overrides.filename ?? 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc',
    diskPath: '',
    finalPath: '/downloads',
    finalName: '',
    torrentMetaPath: null,
    infoHash: 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc',
    uris: ['magnet:?xt=urn:btih:a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'],
    source: 'user',
    sourceMeta: null,
    createdAt: 1000,
    updatedAt: 1000,
    instances: [
      {
        instanceId: `primary:${overrides.id}`,
        motrixId: overrides.id,
        gid: overrides.engineTaskId,
        phase: TaskInstancePhase.BtDownload,
        status: overrides.status ?? TaskStatus.Queued,
        progress: 0,
        totalBytes: 0,
        downloadedBytes: 0,
        uploadedBytes: 0,
        diskPath: '',
        transitionPhase: TransitionPhase.Idle,
        uris: ['magnet:?xt=urn:btih:a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'],
        uriHash: null,
        payload: {},
        createdAt: 1000,
        updatedAt: 1000,
      },
    ],
  })
}

describe('magnet-follow-reconciler', () => {
  it('identifies completed magnet metadata rows with followedBy targets', () => {
    const completedMeta = makeAria2Row({
      gid: 'meta-1',
      status: 'complete',
      followedBy: ['bt-1'],
    })
    expect(isFollowedMagnetMetadata(completedMeta)).toBe(true)
    expect(getFollowedBtGid(completedMeta)).toBe('bt-1')

    expect(
      isFollowedMagnetMetadata(
        makeAria2Row({ gid: 'active-1', status: 'active', followedBy: ['bt'] })
      )
    ).toBe(false)
    expect(
      isFollowedMagnetMetadata(
        makeAria2Row({ gid: 'done-1', status: 'complete' })
      )
    ).toBe(false)
  })

  it('rebinds an owned magnet task to its followed BT gid and updates placeholder name (#2552)', async () => {
    const taskManager = new TaskManager()
    const existing = makeMagnetTask({
      id: 'task-1',
      engineTaskId: 'meta-gid',
    })
    taskManager.set(existing.id, existing)

    const persistTask = vi.fn().mockResolvedValue(undefined)
    const retireMetadataGid = vi.fn()
    const log = { info: vi.fn(), warn: vi.fn() }

    const rawTasks: Aria2TaskStatus[] = [
      makeAria2Row({
        gid: 'bt-gid',
        status: 'active',
        dir: '/downloads',
        infoHash: 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc',
        bittorrent: {
          announceList: [],
          mode: 'single',
          info: { name: 'ubuntu-24.04.iso' },
        },
      }),
      makeAria2Row({
        gid: 'meta-gid',
        status: 'complete',
        followedBy: ['bt-gid'],
      }),
    ]

    const result = await reconcileFollowedMagnetTasks(
      rawTasks,
      { taskManager, persistTask, retireMetadataGid, log },
      2000
    )

    expect(result.dirty).toBe(true)
    expect(result.skippedGids.has('meta-gid')).toBe(true)
    expect(result.skippedGids.has('bt-gid')).toBe(false)
    expect(persistTask).toHaveBeenCalledOnce()
    expect(retireMetadataGid).toHaveBeenCalledWith('meta-gid')

    expect(taskManager.getByEngineTaskId('meta-gid')).toBeUndefined()
    expect(taskManager.isEngineTaskIdRetired('meta-gid')).toBe(true)
    const rebound = taskManager.getByEngineTaskId('bt-gid')
    expect(rebound?.id).toBe('task-1')
    expect(rebound?.name).toBe('ubuntu-24.04.iso')
    expect(rebound?.finalName).toBe('ubuntu-24.04.iso')
    expect(rebound?.finalPath).toBe('/downloads/ubuntu-24.04.iso')
    expect(rebound?.diskPath).toBe('/downloads/ubuntu-24.04.iso')
    expect(rebound?.instances[0]?.gid).toBe('bt-gid')
  })

  it('skips and retires unowned followed metadata rows without adopting a duplicate task', async () => {
    const taskManager = new TaskManager()
    const persistTask = vi.fn().mockResolvedValue(undefined)
    const retireMetadataGid = vi.fn()
    const log = { info: vi.fn(), warn: vi.fn() }

    const result = await reconcileFollowedMagnetTasks(
      [
        makeAria2Row({
          gid: 'meta-unowned',
          status: 'complete',
          followedBy: ['bt-real'],
        }),
      ],
      { taskManager, persistTask, retireMetadataGid, log }
    )

    expect(result.skippedGids.has('meta-unowned')).toBe(true)
    expect(result.dirty).toBe(false)
    expect(persistTask).not.toHaveBeenCalled()
    expect(retireMetadataGid).toHaveBeenCalledWith('meta-unowned')
  })

  it('looks up followed BT status when notification batch contains only metadata row (#2569)', async () => {
    const taskManager = new TaskManager()
    const existing = makeMagnetTask({
      id: 'task-notify',
      engineTaskId: 'meta-gid',
    })
    taskManager.set(existing.id, existing)

    const persistTask = vi.fn().mockResolvedValue(undefined)
    const retireMetadataGid = vi.fn()
    const lookupFollowedTask = vi.fn().mockResolvedValue(
      makeAria2Row({
        gid: 'bt-gid',
        status: 'active',
        dir: '/downloads',
        totalLength: '4096',
        infoHash: 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc',
        bittorrent: {
          announceList: [],
          mode: 'single',
          info: { name: 'debian-13.iso' },
        },
      })
    )
    const log = { info: vi.fn(), warn: vi.fn() }

    const result = await reconcileFollowedMagnetTasks(
      [
        makeAria2Row({
          gid: 'meta-gid',
          status: 'complete',
          followedBy: ['bt-gid'],
        }),
      ],
      {
        taskManager,
        persistTask,
        retireMetadataGid,
        lookupFollowedTask,
        log,
      },
      2500
    )

    expect(result.dirty).toBe(true)
    expect(lookupFollowedTask).toHaveBeenCalledExactlyOnceWith('bt-gid')
    const rebound = taskManager.getByEngineTaskId('bt-gid')
    expect(rebound?.name).toBe('debian-13.iso')
    expect(rebound?.filename).toBe('debian-13.iso')
    expect(rebound?.finalName).toBe('debian-13.iso')
    expect(rebound?.finalPath).toBe('/downloads/debian-13.iso')
    expect(rebound?.diskPath).toBe('/downloads/debian-13.iso')
    expect(rebound?.instances[0]?.diskPath).toBe('/downloads/debian-13.iso')
  })

  it('keeps placeholder unresolved for later poll healing when lookupFollowedTask fails (#2569)', async () => {
    const taskManager = new TaskManager()
    const existing = makeMagnetTask({
      id: 'task-lookup-fail',
      engineTaskId: 'meta-gid',
    })
    taskManager.set(existing.id, existing)

    const persistTask = vi.fn().mockResolvedValue(undefined)
    const retireMetadataGid = vi.fn()
    const lookupFollowedTask = vi
      .fn()
      .mockRejectedValue(new Error('gid not ready'))
    const log = { info: vi.fn(), warn: vi.fn() }

    const result = await reconcileFollowedMagnetTasks(
      [
        makeAria2Row({
          gid: 'meta-gid',
          status: 'complete',
          followedBy: ['bt-gid'],
        }),
      ],
      {
        taskManager,
        persistTask,
        retireMetadataGid,
        lookupFollowedTask,
        log,
      },
      2600
    )

    expect(result.dirty).toBe(true)
    expect(log.warn).toHaveBeenCalledOnce()
    const rebound = taskManager.getByEngineTaskId('bt-gid')
    expect(rebound?.engineTaskId).toBe('bt-gid')
    expect(rebound?.finalName).toBe('')
    expect(rebound?.diskPath).toBe('')
    expect(rebound?.finalPath).toBe('/downloads')
  })
})
