import type { DownloadTask } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { createGetTaskFilesHandler } from './get-task-files'

const mkTask = (over: Partial<DownloadTask> = {}): DownloadTask =>
  makeDownloadTask({
    id: 't1',
    engineTaskId: 'gid1',
    name: 'x',
    kind: TaskKind.Bt,
    type: TaskType.Bt,
    ...over,
  })

describe('getTaskFiles handler', () => {
  it('merges db structure with engine completedBytes when active', async () => {
    const db = {
      getTaskFiles: vi.fn(() => [
        { fileIndex: 0, path: 'a.bin', size: 100, selected: true },
        { fileIndex: 1, path: 'b.bin', size: 200, selected: false },
      ]),
    }
    const taskManager = {
      getById: vi.fn(() => mkTask({ status: TaskStatus.Downloading })),
    }
    const engine = {
      getTaskFiles: vi.fn(async () => [
        {
          index: 0,
          path: 'a.bin',
          size: 100,
          completedBytes: 30,
          selected: true,
        },
        {
          index: 1,
          path: 'b.bin',
          size: 200,
          completedBytes: 50,
          selected: false,
        },
      ]),
    }
    const handler = createGetTaskFilesHandler({
      db,
      taskManager,
      engine,
    } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])
    const result = await handler('t1')
    expect(result[0]?.completedBytes).toBe(30)
    expect(result[1]?.completedBytes).toBe(50)
  })

  it('returns 0 completedBytes when paused', async () => {
    const db = {
      getTaskFiles: vi.fn(() => [
        { fileIndex: 0, path: 'a.bin', size: 100, selected: true },
      ]),
    }
    const taskManager = {
      getById: vi.fn(() => mkTask({ status: TaskStatus.Paused })),
    }
    const engine = { getTaskFiles: vi.fn() }
    const handler = createGetTaskFilesHandler({
      db,
      taskManager,
      engine,
    } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])
    const result = await handler('t1')
    expect(result[0]?.completedBytes).toBe(0)
    expect(engine.getTaskFiles).not.toHaveBeenCalled()
  })

  it('returns size as completedBytes when completed', async () => {
    const db = {
      getTaskFiles: vi.fn(() => [
        { fileIndex: 0, path: 'a.bin', size: 100, selected: true },
      ]),
    }
    const taskManager = {
      getById: vi.fn(() => mkTask({ status: TaskStatus.Completed })),
    }
    const handler = createGetTaskFilesHandler({
      db,
      taskManager,
      engine: { getTaskFiles: vi.fn() },
    } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])
    const result = await handler('t1')
    expect(result[0]?.completedBytes).toBe(100)
  })

  it.each([TaskType.Http, TaskType.Ftp])(
    'hides the direct-download staging suffix from persisted %s file rows',
    async (type) => {
      const db = {
        getTaskFiles: vi.fn(() => [
          {
            fileIndex: 0,
            path: 'C:\\Users\\x\\Downloads\\release.motrix.motrix',
            size: 100,
            selected: true,
          },
        ]),
      }
      const taskManager = {
        getById: vi.fn(() =>
          mkTask({
            kind: TaskKind.Direct,
            type,
            status: TaskStatus.Paused,
            saveDir: 'C:\\Users\\x\\Downloads',
            diskPath: 'C:\\Users\\x\\Downloads\\release.motrix.motrix',
            finalPath: 'C:\\Users\\x\\Downloads\\release.motrix',
            finalName: 'release.motrix',
          })
        ),
      }
      const engine = { getTaskFiles: vi.fn() }
      const handler = createGetTaskFilesHandler({
        db,
        taskManager,
        engine,
      } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])

      const result = await handler('t1')

      expect(result[0]?.path).toBe('release.motrix')
      expect(db.getTaskFiles.mock.results[0]?.value[0]?.path).toBe(
        'C:\\Users\\x\\Downloads\\release.motrix.motrix'
      )
      expect(engine.getTaskFiles).not.toHaveBeenCalled()
    }
  )

  it('preserves a completed direct-download name that legitimately ends in .motrix', async () => {
    const finalPath = 'C:\\Users\\x\\Downloads\\release.motrix'
    const db = {
      getTaskFiles: vi.fn(() => [
        {
          fileIndex: 0,
          path: finalPath,
          size: 100,
          selected: true,
        },
      ]),
    }
    const taskManager = {
      getById: vi.fn(() =>
        mkTask({
          kind: TaskKind.Direct,
          type: TaskType.Http,
          status: TaskStatus.Completed,
          saveDir: 'C:\\Users\\x\\Downloads',
          diskPath: finalPath,
          finalPath,
          finalName: 'release.motrix',
        })
      ),
    }
    const engine = { getTaskFiles: vi.fn() }
    const handler = createGetTaskFilesHandler({
      db,
      taskManager,
      engine,
    } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])

    const result = await handler('t1')

    expect(result[0]?.path).toBe('release.motrix')
    expect(engine.getTaskFiles).not.toHaveBeenCalled()
  })

  it('hides the suffix from a legacy completed HTTP row that still points at staging', async () => {
    const db = {
      getTaskFiles: vi.fn(() => [
        {
          fileIndex: 0,
          path: 'C:\\Users\\x\\Downloads\\example.zip.motrix',
          size: 100,
          selected: true,
        },
      ]),
    }
    const taskManager = {
      getById: vi.fn(() =>
        mkTask({
          kind: TaskKind.Direct,
          type: TaskType.Http,
          status: TaskStatus.Completed,
          saveDir: 'C:\\Users\\x\\Downloads',
          diskPath: 'C:\\Users\\x\\Downloads\\example.zip',
          finalPath: 'C:\\Users\\x\\Downloads\\example.zip',
          finalName: 'example.zip',
        })
      ),
    }
    const engine = { getTaskFiles: vi.fn() }
    const handler = createGetTaskFilesHandler({
      db,
      taskManager,
      engine,
    } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])

    const result = await handler('t1')

    expect(result[0]?.path).toBe('example.zip')
    expect(engine.getTaskFiles).not.toHaveBeenCalled()
  })

  it.each([TaskType.Http, TaskType.Ftp])(
    'hides the direct-download staging suffix in the %s engine fallback',
    async (type) => {
      const physicalPath = 'C:\\Users\\x\\Downloads\\example.zip.motrix'
      const db = { getTaskFiles: vi.fn(() => []) }
      const taskManager = {
        getById: vi.fn(() =>
          mkTask({
            kind: TaskKind.Direct,
            type,
            status: TaskStatus.Downloading,
            saveDir: 'C:\\Users\\x\\Downloads',
            diskPath: physicalPath,
            finalPath: 'C:\\Users\\x\\Downloads\\example.zip',
            finalName: 'example.zip',
          })
        ),
      }
      const engine = {
        getTaskFiles: vi.fn(async () => [
          {
            index: 0,
            path: physicalPath,
            size: 100,
            completedBytes: 40,
            selected: true,
          },
        ]),
      }
      const handler = createGetTaskFilesHandler({
        db,
        taskManager,
        engine,
      } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])

      const result = await handler('t1')

      expect(result[0]?.path).toBe('example.zip')
      expect(engine.getTaskFiles).toHaveBeenCalledWith('gid1')
    }
  )

  it.each([
    [TaskType.Bt, TaskKind.Bt],
    [TaskType.Magnet, TaskKind.Bt],
    [TaskType.Http, TaskKind.Mux],
  ])(
    'preserves a real .motrix payload name for %s/%s tasks',
    async (type, kind) => {
      const db = {
        getTaskFiles: vi.fn(() => [
          {
            fileIndex: 0,
            path: 'C:\\Users\\x\\Downloads\\payload.motrix',
            size: 100,
            selected: true,
          },
        ]),
      }
      const taskManager = {
        getById: vi.fn(() =>
          mkTask({
            kind,
            type,
            status: TaskStatus.Paused,
            saveDir: 'C:\\Users\\x\\Downloads',
            diskPath: 'C:\\Users\\x\\Downloads\\torrent-staging',
          })
        ),
      }
      const handler = createGetTaskFilesHandler({
        db,
        taskManager,
        engine: { getTaskFiles: vi.fn() },
      } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])

      const result = await handler('t1')

      expect(result[0]?.path).toBe('payload.motrix')
    }
  )

  it('degrades to 0 if engine.getTaskFiles throws', async () => {
    const db = {
      getTaskFiles: vi.fn(() => [
        { fileIndex: 0, path: 'a.bin', size: 100, selected: true },
      ]),
    }
    const taskManager = {
      getById: vi.fn(() => mkTask({ status: TaskStatus.Downloading })),
    }
    const engine = {
      getTaskFiles: vi.fn(async () => {
        throw new Error('rpc down')
      }),
    }
    const handler = createGetTaskFilesHandler({
      db,
      taskManager,
      engine,
    } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])
    const result = await handler('t1')
    expect(result[0]?.completedBytes).toBe(0)
  })

  it('skips the engine call for a coordinator-managed media task (empty engineTaskId)', async () => {
    // A Mux/Hls task has engineTaskId '' (no aria2 handle). Calling
    // engine.getTaskFiles('') just fails and logs a warning every time the
    // Files tab opens — same "never touch the engine with ''" rule as pause.
    const db = { getTaskFiles: vi.fn(() => []) }
    const taskManager = {
      getById: vi.fn(() =>
        mkTask({
          engineTaskId: '',
          kind: TaskKind.Mux,
          type: TaskType.Http,
          status: TaskStatus.Downloading,
        })
      ),
    }
    const engine = { getTaskFiles: vi.fn() }
    const handler = createGetTaskFilesHandler({
      db,
      taskManager,
      engine,
    } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])

    const result = await handler('m1')

    expect(result).toEqual([])
    expect(engine.getTaskFiles).not.toHaveBeenCalled()
  })

  it('synthesizes full structure from engine when db is empty (active task)', async () => {
    // Regression: before this fix, GetTaskFiles returned an empty array
    // when task_files hadn't been auto-synced yet, even though the engine
    // had the file list. Header would render "1 file selected · 0 B"
    // (from task.bt.selectedFiles) but no rows.
    const db = {
      getTaskFiles: vi.fn(() => []),
    }
    const taskManager = {
      getById: vi.fn(() => mkTask({ status: TaskStatus.Downloading })),
    }
    const engine = {
      getTaskFiles: vi.fn(async () => [
        {
          index: 0,
          path: 'ubuntu-25.10-desktop-amd64.iso',
          size: 6_500_000_000,
          completedBytes: 1_000_000_000,
          selected: true,
        },
      ]),
    }
    const handler = createGetTaskFilesHandler({
      db,
      taskManager,
      engine,
    } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])
    const result = await handler('t1')
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe('ubuntu-25.10-desktop-amd64.iso')
    expect(result[0]?.size).toBe(6_500_000_000)
    expect(result[0]?.completedBytes).toBe(1_000_000_000)
    expect(result[0]?.selected).toBe(true)
  })

  it('replaces persisted magnet placeholders from engine for a completed task', async () => {
    const db = {
      getTaskFiles: vi.fn(() => [
        { fileIndex: 0, path: '', size: 0, selected: true },
        { fileIndex: 1, path: '', size: 0, selected: true },
      ]),
    }
    const taskManager = {
      getById: vi.fn(() => mkTask({ status: TaskStatus.Completed })),
    }
    const engine = {
      getTaskFiles: vi.fn(async () => [
        {
          index: 0,
          path: '/Downloads/Show.motrix/episode-01.mkv',
          size: 1_500_000_000,
          completedBytes: 1_500_000_000,
          selected: true,
        },
        {
          index: 1,
          path: '/Downloads/Show.motrix/episode-02.mkv',
          size: 1_600_000_000,
          completedBytes: 1_600_000_000,
          selected: true,
        },
      ]),
    }
    const handler = createGetTaskFilesHandler({
      db,
      taskManager,
      engine,
    } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])

    const result = await handler('t1')

    expect(result).toEqual([
      expect.objectContaining({
        index: 0,
        path: 'episode-01.mkv',
        size: 1_500_000_000,
      }),
      expect.objectContaining({
        index: 1,
        path: 'episode-02.mkv',
        size: 1_600_000_000,
      }),
    ])
    expect(engine.getTaskFiles).toHaveBeenCalledWith('gid1')
  })

  it('relativizes absolute file path against task.diskPath (single-file BT)', async () => {
    // aria2 returns the absolute disk path including the .motrix container.
    // Provider must strip the diskPath prefix so the UI shows just the
    // torrent-internal name (the demo Ubuntu single-file scenario).
    const absolutePath =
      '/Users/x/Downloads/ubuntu-25.10-desktop-amd64.iso.motrix/ubuntu-25.10-desktop-amd64.iso'
    const diskPath = '/Users/x/Downloads/ubuntu-25.10-desktop-amd64.iso.motrix'
    const db = {
      getTaskFiles: vi.fn(() => [
        {
          fileIndex: 0,
          path: absolutePath,
          size: 6_500_000_000,
          selected: true,
        },
      ]),
    }
    const taskManager = {
      getById: vi.fn(() =>
        mkTask({
          status: TaskStatus.Downloading,
          diskPath,
          saveDir: '/Users/x/Downloads',
        })
      ),
    }
    const engine = {
      getTaskFiles: vi.fn(async () => [
        {
          index: 0,
          path: absolutePath,
          size: 6_500_000_000,
          completedBytes: 1_000_000_000,
          selected: true,
        },
      ]),
    }
    const handler = createGetTaskFilesHandler({
      db,
      taskManager,
      engine,
    } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])
    const result = await handler('t1')
    expect(result[0]?.path).toBe('ubuntu-25.10-desktop-amd64.iso')
  })

  it('relativizes absolute file path preserving subdirs (multi-file BT)', async () => {
    const absolutePath = '/Users/x/Downloads/Album.motrix/CD1/track01.flac'
    const diskPath = '/Users/x/Downloads/Album.motrix'
    const db = { getTaskFiles: vi.fn(() => []) }
    const taskManager = {
      getById: vi.fn(() =>
        mkTask({
          status: TaskStatus.Downloading,
          diskPath,
          saveDir: '/Users/x/Downloads',
        })
      ),
    }
    const engine = {
      getTaskFiles: vi.fn(async () => [
        {
          index: 0,
          path: absolutePath,
          size: 50_000_000,
          completedBytes: 0,
          selected: true,
        },
      ]),
    }
    const handler = createGetTaskFilesHandler({
      db,
      taskManager,
      engine,
    } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])
    const result = await handler('t1')
    expect(result[0]?.path).toBe('CD1/track01.flac')
  })

  it('hides the indexed payload entry from in-flight file paths', async () => {
    const workspacePath = '/Users/x/Downloads/.motrix/0123456789abcdefabcd'
    const absolutePath = `${workspacePath}/p/CD1/track01.flac`
    const db = { getTaskFiles: vi.fn(() => []) }
    const taskManager = {
      getById: vi.fn(() =>
        mkTask({
          status: TaskStatus.Downloading,
          diskPath: workspacePath,
          saveDir: '/Users/x/Downloads',
          instances: [
            {
              instanceId: 'primary:t1',
              motrixId: 't1',
              gid: 'gid1',
              phase: TaskInstancePhase.BtDownload,
              status: TaskStatus.Downloading,
              progress: 0,
              totalBytes: 0,
              downloadedBytes: 0,
              uploadedBytes: 0,
              diskPath: workspacePath,
              transitionPhase: TransitionPhase.Idle,
              uris: [],
              uriHash: null,
              payload: {
                btStorageLayout: {
                  version: 1,
                  strategy: 'indexed-staging',
                  workspacePath,
                  payloadEntry: 'p',
                  torrentRootName: 'Original album name',
                  multiFile: true,
                },
              },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        })
      ),
    }
    const engine = {
      getTaskFiles: vi.fn(async () => [
        {
          index: 0,
          path: absolutePath,
          size: 50,
          completedBytes: 20,
          selected: true,
        },
      ]),
    }
    const handler = createGetTaskFilesHandler({
      db,
      taskManager,
      engine,
    } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])

    const result = await handler('t1')

    expect(result[0]?.path).toBe('CD1/track01.flac')
  })

  it('restores the torrent name for an indexed single-file payload', async () => {
    const workspacePath = '/Users/x/Downloads/.motrix/0123456789abcdefabcd'
    const absolutePath = `${workspacePath}/p`
    const torrentRootName = 'ubuntu-25.10-desktop-amd64.iso'
    const db = {
      getTaskFiles: vi.fn(() => [
        {
          fileIndex: 0,
          path: absolutePath,
          size: 6_500_000_000,
          selected: true,
        },
      ]),
    }
    const taskManager = {
      getById: vi.fn(() =>
        mkTask({
          status: TaskStatus.Downloading,
          diskPath: workspacePath,
          saveDir: '/Users/x/Downloads',
          instances: [
            {
              instanceId: 'primary:t1',
              motrixId: 't1',
              gid: 'gid1',
              phase: TaskInstancePhase.BtDownload,
              status: TaskStatus.Downloading,
              progress: 0,
              totalBytes: 0,
              downloadedBytes: 0,
              uploadedBytes: 0,
              diskPath: workspacePath,
              transitionPhase: TransitionPhase.Idle,
              uris: [],
              uriHash: null,
              payload: {
                btStorageLayout: {
                  version: 1,
                  strategy: 'indexed-staging',
                  workspacePath,
                  payloadEntry: 'p',
                  torrentRootName,
                  multiFile: false,
                },
              },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        })
      ),
    }
    const engine = {
      getTaskFiles: vi.fn(async () => [
        {
          index: 0,
          path: absolutePath,
          size: 6_500_000_000,
          completedBytes: 3_250_000_000,
          selected: true,
        },
      ]),
    }
    const handler = createGetTaskFilesHandler({
      db,
      taskManager,
      engine,
    } as unknown as Parameters<typeof createGetTaskFilesHandler>[0])

    const result = await handler('t1')

    expect(result[0]?.path).toBe(torrentRootName)
  })
})
