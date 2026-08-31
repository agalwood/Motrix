import path from 'node:path'
import { INCOMPLETE_SUFFIX } from '@shared/constants/incomplete'
import type { DownloadTask } from '@shared/types/task'
import {
  makeDownloadTask,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FsCreateCollisionGuard,
  isTerminalTaskStatus,
} from './create-collision-policy'

const { statMock, unlinkMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  unlinkMock: vi.fn(async () => undefined),
}))

vi.mock('node:fs/promises', () => {
  const stub = { stat: statMock, unlink: unlinkMock }
  return { ...stub, default: stub }
})

const SAVE_DIR = path.join('d', 'save')
const FINAL_PATH = path.join(SAVE_DIR, 'a.json')
const STAGING_PATH = FINAL_PATH + INCOMPLETE_SUFFIX

function fsWith(existingPaths: string[]): void {
  statMock.mockImplementation(async (p: string) => {
    if (existingPaths.includes(p)) return { isFile: () => true }
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
    err.code = 'ENOENT'
    throw err
  })
}

function httpTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 't1',
    name: 'a.json',
    type: TaskType.Http,
    kind: TaskKind.Direct,
    saveDir: SAVE_DIR,
    createdAt: 1,
    updatedAt: 1,
    filename: 'a.json',
    finalName: 'a.json',
    finalPath: FINAL_PATH,
    diskPath: STAGING_PATH,
    source: 'user',
    sourceMeta: null,
    instances: [
      {
        instanceId: 'primary:t1',
        motrixId: 't1',
        gid: 'gid-1',
        phase: TaskInstancePhase.HttpDownload,
        status: TaskStatus.Downloading,
        progress: 0.5,
        totalBytes: 100,
        downloadedBytes: 50,
        uploadedBytes: 0,
        diskPath: STAGING_PATH,
        transitionPhase: TransitionPhase.Idle,
        uris: [],
        uriHash: null,
        payload: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    ...overrides,
  })
}

const INPUT = {
  saveDir: SAVE_DIR,
  name: 'a.json',
  tasks: [] as DownloadTask[],
}

describe('isTerminalTaskStatus', () => {
  it('treats completed/error/removed as terminal', () => {
    expect(isTerminalTaskStatus(TaskStatus.Completed)).toBe(true)
    expect(isTerminalTaskStatus(TaskStatus.Error)).toBe(true)
    expect(isTerminalTaskStatus(TaskStatus.Removed)).toBe(true)
  })

  it('treats active statuses as non-terminal', () => {
    for (const s of [
      TaskStatus.Queued,
      TaskStatus.Downloading,
      TaskStatus.Finalizing,
      TaskStatus.Seeding,
      TaskStatus.Paused,
      TaskStatus.FetchingMetadata,
      TaskStatus.MetadataReady,
    ]) {
      expect(isTerminalTaskStatus(s)).toBe(false)
    }
  })
})

describe('FsCreateCollisionGuard.decide', () => {
  beforeEach(() => {
    statMock.mockReset()
    unlinkMock.mockClear()
  })

  it('skips when the final file exists', async () => {
    fsWith([FINAL_PATH])
    const decision = await new FsCreateCollisionGuard().decide(INPUT)
    expect(decision).toEqual({
      action: 'skip',
      reason: 'final-exists',
      finalPath: FINAL_PATH,
      ownerTaskId: null,
    })
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('skips when an active task owns the staging file', async () => {
    fsWith([STAGING_PATH])
    const decision = await new FsCreateCollisionGuard().decide({
      ...INPUT,
      tasks: [httpTask({ status: TaskStatus.Downloading })],
    })
    expect(decision).toEqual({
      action: 'skip',
      reason: 'active-staging',
      finalPath: FINAL_PATH,
      ownerTaskId: 't1',
    })
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('skips when a queued task owns the staging slot even before the file exists', async () => {
    // The staging file is not yet created on disk (aria2 opens it only when
    // the download starts), but the queued task has already reserved the
    // staging path. A duplicate add must still be skipped.
    fsWith([])
    const decision = await new FsCreateCollisionGuard().decide({
      ...INPUT,
      tasks: [httpTask({ status: TaskStatus.Queued })],
    })
    expect(decision).toEqual({
      action: 'skip',
      reason: 'active-staging',
      finalPath: FINAL_PATH,
      ownerTaskId: 't1',
    })
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('deletes a stale staging file when the owning task is terminal', async () => {
    fsWith([STAGING_PATH])
    const decision = await new FsCreateCollisionGuard().decide({
      ...INPUT,
      tasks: [httpTask({ status: TaskStatus.Completed })],
    })
    expect(decision).toEqual({
      action: 'proceed',
      finalPath: FINAL_PATH,
      ownerTaskId: null,
    })
    expect(unlinkMock).toHaveBeenCalledWith(STAGING_PATH)
  })

  it('deletes a stale staging file when no task owns it', async () => {
    fsWith([STAGING_PATH])
    const decision = await new FsCreateCollisionGuard().decide(INPUT)
    expect(decision.action).toBe('proceed')
    expect(unlinkMock).toHaveBeenCalledWith(STAGING_PATH)
  })

  it('proceeds even when the stale staging unlink fails', async () => {
    fsWith([STAGING_PATH])
    unlinkMock.mockRejectedValueOnce(new Error('EBUSY'))
    const decision = await new FsCreateCollisionGuard().decide(INPUT)
    expect(decision.action).toBe('proceed')
  })

  it('proceeds when neither file exists', async () => {
    fsWith([])
    const decision = await new FsCreateCollisionGuard().decide(INPUT)
    expect(decision).toEqual({
      action: 'proceed',
      finalPath: FINAL_PATH,
      ownerTaskId: null,
    })
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('ignores tasks whose diskPath differs (different staging slot)', async () => {
    fsWith([STAGING_PATH])
    const other = httpTask({
      id: 't2',
      diskPath: path.join('elsewhere', 'other.json') + INCOMPLETE_SUFFIX,
    })
    const decision = await new FsCreateCollisionGuard().decide({
      ...INPUT,
      tasks: [other],
    })
    expect(decision.action).toBe('proceed')
    expect(unlinkMock).toHaveBeenCalledWith(STAGING_PATH)
  })
})