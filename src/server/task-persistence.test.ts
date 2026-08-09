import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Aria2RpcClient } from '@core/engine/aria2/aria2-rpc-client'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { MotrixDatabase } from '@core/session/motrix-database'
import { SessionManager } from '@core/session/session-manager'
import { TaskManager } from '@core/task/task-manager'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServerPersistTask } from './task-persistence'

function createEmptyRpc(): Aria2RpcClient {
  return {
    tellActive: vi.fn().mockResolvedValue([]),
    tellWaiting: vi.fn().mockResolvedValue([]),
    tellStopped: vi.fn().mockResolvedValue([]),
  } as unknown as Aria2RpcClient
}

function createTerminalMediaTask(
  id: string,
  status: TaskStatus.Completed | TaskStatus.Error
) {
  const now = 1_700_000_000_000
  const finalPath = `/downloads/${id}.mp4`
  return makeDownloadTask({
    id,
    engineTaskId: '',
    name: `${id}.mp4`,
    kind: TaskKind.Mux,
    status,
    progress: status === TaskStatus.Completed ? 1 : 0.5,
    totalBytes: 1_000,
    downloadedBytes: 1_000,
    saveDir: '/downloads',
    createdAt: now - 1_000,
    updatedAt: now,
    finishedAt: now,
    errorMessage: status === TaskStatus.Error ? 'ffmpeg failed' : null,
    filename: `${id}.mp4`,
    sizeWhenDone: 1_000,
    diskPath: finalPath,
    finalPath,
    finalName: `${id}.mp4`,
    instances: [
      {
        instanceId: `mux:${id}`,
        motrixId: id,
        gid: null,
        phase: TaskInstancePhase.FfmpegMux,
        status,
        progress: status === TaskStatus.Completed ? 1 : 0.5,
        totalBytes: 1_000,
        downloadedBytes: 1_000,
        uploadedBytes: 0,
        diskPath: finalPath,
        transitionPhase: TransitionPhase.Idle,
        uris: [],
        uriHash: null,
        payload: {},
        createdAt: now - 1_000,
        updatedAt: now,
      },
    ],
  })
}

describe('createServerPersistTask', () => {
  let tempDir: string
  let openDatabases: MotrixDatabase[]

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'motrix-server-persist-'))
    openDatabases = []
  })

  afterEach(() => {
    for (const db of openDatabases) {
      try {
        db.close()
      } catch {
        // The restart test closes the first connection before opening the next.
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function openDatabase(dbPath: string): MotrixDatabase {
    const db = new MotrixDatabase(dbPath)
    db.init()
    openDatabases.push(db)
    return db
  }

  it('serializes terminal media writes and restores them after restart', async () => {
    const dbPath = path.join(tempDir, 'motrix.db')
    const taskManager = new TaskManager()
    const db = openDatabase(dbPath)
    const saveBatch = vi.spyOn(db, 'saveTaskWithInstances')
    const sessionManager = new SessionManager(
      taskManager,
      createEmptyRpc(),
      db,
      {} as EngineAdapter
    )
    const persistTask = createServerPersistTask(taskManager, sessionManager)

    await Promise.all([
      persistTask(
        createTerminalMediaTask('media-complete', TaskStatus.Completed)
      ),
      persistTask(createTerminalMediaTask('media-error', TaskStatus.Error)),
    ])

    expect(saveBatch).toHaveBeenCalledTimes(2)
    db.close()

    const restartedDb = openDatabase(dbPath)
    const restartedTasks = new TaskManager()
    const restartedSession = new SessionManager(
      restartedTasks,
      createEmptyRpc(),
      restartedDb,
      {} as EngineAdapter
    )
    await restartedSession.restore()

    expect(restartedTasks.getById('media-complete')).toMatchObject({
      status: TaskStatus.Completed,
      finishedAt: 1_700_000_000_000,
      finalPath: '/downloads/media-complete.mp4',
    })
    expect(restartedTasks.getById('media-error')).toMatchObject({
      status: TaskStatus.Error,
      finishedAt: 1_700_000_000_000,
      errorMessage: 'ffmpeg failed',
    })
  })

  it('rejects the lifecycle barrier when the SQLite snapshot fails', async () => {
    const taskManager = new TaskManager()
    const sessionManager = {
      persistTask: vi.fn(async () => {
        throw new Error('disk full')
      }),
    }
    const persistTask = createServerPersistTask(
      taskManager,
      sessionManager as Pick<SessionManager, 'persistTask'>
    )
    const task = createTerminalMediaTask(
      'media-disk-full',
      TaskStatus.Completed
    )

    await expect(persistTask(task)).rejects.toThrow('disk full')
    expect(taskManager.getById(task.id)).toBeUndefined()
  })
})
