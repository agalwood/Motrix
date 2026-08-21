import { initLogger } from '@core/logger'
import { AppError, ErrorCode } from '@shared/errors'
import type { DownloadTask } from '@shared/types/task'
import { TaskType, TransitionPhase } from '@shared/types/task'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Aria2Adapter } from '../engine/aria2/aria2-adapter'
import { handleCreateTask } from './create-task-handler'

// Stub `mkdir` (and the other `fs.*` calls inadvertently dragged
// in via TorrentMetaStore) so unit tests don't touch the real
// filesystem. The production code calls
//   `mkdir(<saveDir-or-diskPath>, { recursive: true })`
// with paths like '/d/foo.bin.motrix' which would either fail with
// EACCES or — worse — actually mutate the runner's filesystem. The
// mock also lets us assert WHICH path the production code chose,
// which is the whole point of the BT-vs-HTTP type-gate fix.
//
// `vi.hoisted` is required: `vi.mock` is hoisted above all imports,
// and so are the closures it captures. A plain `const mkdirMock` at
// module scope would be `undefined` when the mock factory runs.
//
// Both `default` and named exports are provided so that TorrentMetaStore's
// `import fs from 'node:fs/promises'` (default) and createTaskHandler's
// `import { mkdir } from 'node:fs/promises'` (named) both resolve.
const { mkdirMock, fsStub } = vi.hoisted(() => {
  const mkdirMock = vi.fn(async () => undefined)
  const fsStub = {
    mkdir: mkdirMock,
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => Buffer.alloc(0)),
    unlink: vi.fn(async () => undefined),
  }
  return { mkdirMock, fsStub }
})
vi.mock('node:fs/promises', () => ({
  ...fsStub,
  default: fsStub,
}))

const logInfo = vi.fn()
const logWarn = vi.fn()
const logError = vi.fn()
const logDebug = vi.fn()

beforeEach(() => {
  mkdirMock.mockClear()
  logInfo.mockClear()
  logWarn.mockClear()
  logError.mockClear()
  logDebug.mockClear()
  initLogger({
    child: () => ({
      info: logInfo,
      warn: logWarn,
      error: logError,
      debug: logDebug,
    }),
  } as never)
})

// Build a minimal valid bencoded torrent with an optional private flag.
// Shape: d4:infod<private field?>6:lengthi1024e4:name<N>:<name>
//   12:piece lengthi16384e6:pieces20:<20 zero bytes>ee
function buildMinimalTorrentBytes(
  name: string,
  isPrivate: boolean
): Uint8Array {
  const privateField = isPrivate ? '7:privatei1e' : ''
  const nameField = `4:name${Buffer.byteLength(name, 'utf8')}:${name}`
  const prefix = Buffer.from(
    `d4:infod${privateField}6:lengthi1024e${nameField}12:piece lengthi16384e6:pieces20:`,
    'utf8'
  )
  const pieces = Buffer.alloc(20)
  const suffix = Buffer.from('ee', 'utf8')
  return new Uint8Array(Buffer.concat([prefix, pieces, suffix]))
}

function makePrivateTorrentFixture(): Uint8Array {
  return buildMinimalTorrentBytes('private-torrent', true)
}

function makePublicTorrentFixture(): Uint8Array {
  return buildMinimalTorrentBytes('public-torrent', false)
}

type Deps = Parameters<typeof handleCreateTask>[1]

interface DepOverrides {
  addUriGid?: string
  addTorrentGid?: string
  pick?: (dir: string, name: string) => Promise<string>
  persist?: (id: string, bytes: Uint8Array) => Promise<string>
  defaultSaveDir?: string
  waitForEngineReady?: () => Promise<void>
  prepareSaveDir?: (requested: string) => Promise<string>
}

function httpRequest() {
  return {
    type: 'http',
    uris: ['https://a/b'],
    saveDir: '/d',
    headers: [],
  }
}

function makeDeps(overrides: DepOverrides = {}): Deps & {
  addUri: ReturnType<typeof vi.fn>
  addTorrent: ReturnType<typeof vi.fn>
  pick: ReturnType<typeof vi.fn>
  persist: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  add: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  setReservedEngineTaskOwner: ReturnType<typeof vi.fn>
  rollbackReservedEngineTaskOwner: ReturnType<typeof vi.fn>
  reserveEngineTaskId: ReturnType<typeof vi.fn>
  releaseEngineTaskIdReservation: ReturnType<typeof vi.fn>
  retireEngineTaskIdReservation: ReturnType<typeof vi.fn>
  forceRemove: ReturnType<typeof vi.fn>
  removeDownloadResult: ReturnType<typeof vi.fn>
  waitForEngineReady?: () => Promise<void>
} {
  const addUri = vi.fn(
    async (_uris: string[], options: Record<string, unknown>) =>
      String(options.gid ?? overrides.addUriGid ?? 'gid-http')
  )
  const addTorrent = vi.fn(
    async (
      _metadata: string,
      _uris: string[],
      options: Record<string, unknown>
    ) => String(options.gid ?? overrides.addTorrentGid ?? 'gid-bt')
  )
  const forceRemove = vi.fn(async () => undefined)
  const removeDownloadResult = vi.fn(async () => undefined)
  const pick = vi.fn(
    overrides.pick ?? (async (_dir: string, name: string) => name)
  )
  const persist = vi.fn(
    overrides.persist ?? (async (id: string) => `/torrents/${id}.torrent`)
  )
  const set = vi.fn()
  const add = vi.fn()
  const remove = vi.fn(() => true)
  const setReservedEngineTaskOwner = vi.fn()
  const rollbackReservedEngineTaskOwner = vi.fn(() => true)
  const reserveEngineTaskId = vi.fn()
  const releaseEngineTaskIdReservation = vi.fn(() => true)
  const retireEngineTaskIdReservation = vi.fn(() => true)
  // Route the create path through a REAL Aria2Adapter wrapping mock rpc
  // spies. The characterization tests then inspect the SAME `addUri` /
  // `addTorrent` calls (the actual aria2 wire) the adapter emits — proving
  // byte-identity. The three `on*` subscriptions are required by the
  // Aria2Adapter constructor; they are no-op stubs here.
  const rpcClient = {
    addUri,
    addTorrent,
    forceRemove,
    removeDownloadResult,
    onBtDownloadComplete: vi.fn(),
    onDownloadComplete: vi.fn(),
    onDownloadError: vi.fn(),
  }
  // The mock rpc only needs the subset Aria2Adapter touches on the create
  // path (addUri/addTorrent + the three on* subscriptions).
  const adapter = new Aria2Adapter(rpcClient as never)
  const settingsManager = {
    getApp: () => ({
      defaultSaveDir: overrides.defaultSaveDir ?? '/fallback',
    }),
    getEngine: () => ({ maxConnectionPerServer: 16 }),
  } as unknown as Deps['settingsManager']
  const finalNamePicker = { pick } as unknown as Deps['finalNamePicker']
  const torrentMetaStore = {
    persist,
    read: vi.fn(),
    remove: vi.fn(),
  } as unknown as Deps['torrentMetaStore']
  const taskManager = {
    set,
    add,
    remove,
    getAll: vi.fn(),
    getById: vi.fn(),
    getByEngineTaskId: vi.fn(),
    clear: vi.fn(),
    setReservedEngineTaskOwner,
    rollbackReservedEngineTaskOwner,
    reserveEngineTaskId,
    releaseEngineTaskIdReservation,
    retireEngineTaskIdReservation,
  } as unknown as Deps['taskManager']
  const eventBus = { emit: vi.fn() }
  const activityRecorder = {
    recordSubmitted: vi.fn(),
    recordDownloadCompleted: vi.fn(),
  }
  const deps: ReturnType<typeof makeDeps> = {
    adapter,
    settingsManager,
    finalNamePicker,
    torrentMetaStore,
    taskManager,
    activityRecorder,
    eventBus,
    addUri,
    addTorrent,
    pick,
    persist,
    set,
    add,
    remove,
    setReservedEngineTaskOwner,
    rollbackReservedEngineTaskOwner,
    reserveEngineTaskId,
    releaseEngineTaskIdReservation,
    retireEngineTaskIdReservation,
    forceRemove,
    removeDownloadResult,
    // Spy pass-through: keeps legacy ordering assertions on eventBus.emit
    // valid while the production path routes through the publisher.
    publishTaskUpdate: vi.fn(() => {
      eventBus.emit('event:taskUpdated', [])
    }),
  }
  if (overrides.waitForEngineReady)
    deps.waitForEngineReady = overrides.waitForEngineReady
  if (overrides.prepareSaveDir) deps.prepareSaveDir = overrides.prepareSaveDir
  return deps
}

function lastAddedTask(deps: { add: ReturnType<typeof vi.fn> }): DownloadTask {
  expect(deps.add).toHaveBeenCalledOnce()
  const call = deps.add.mock.calls[0]
  return call[0] as DownloadTask
}

describe('handleCreateTask', () => {
  it('rejects invalid payload with AppError', async () => {
    await expect(handleCreateTask({ junk: true }, makeDeps())).rejects.toThrow(
      AppError
    )
  })

  it('redacts sensitive create data while retaining safe engine diagnostics', async () => {
    const secrets = {
      urlToken: 'URL_SECRET_123',
      authorization: 'AUTH_SECRET_456',
      cookie: 'COOKIE_SECRET_789',
      proxy: 'PROXY_SECRET_321',
      referer: 'REFERER_SECRET_654',
      cookieJar: 'COOKIE_JAR_SECRET_987',
      unknownOption: 'UNKNOWN_OPTION_SECRET_159',
    }

    await handleCreateTask(
      {
        type: 'http',
        uris: [`https://example.com/file.zip?token=${secrets.urlToken}`],
        saveDir: '/d',
        filename: 'file.zip',
        connections: 8,
        headers: [
          {
            name: 'Authorization',
            value: `Bearer ${secrets.authorization}`,
          },
          {
            name: 'Cookie',
            value: `session=${secrets.cookie}`,
          },
        ],
        proxy: `http://user:${secrets.proxy}@proxy.example:8080`,
      },
      makeDeps(),
      {
        extraEngineOptions: {
          referer: `https://origin.example/watch?token=${secrets.referer}`,
          'load-cookies': `/tmp/${secrets.cookieJar}.txt`,
          'unknown-option': secrets.unknownOption,
        },
      }
    )

    const serializedLogs = JSON.stringify(logInfo.mock.calls)
    for (const secret of Object.values(secrets)) {
      expect(serializedLogs).not.toContain(secret)
    }

    const dispatch = logInfo.mock.calls.find(
      (call) => call[1] === 'dispatching to engine'
    )
    expect(dispatch?.[0]).toMatchObject({
      method: 'createDownload',
      uriCount: 1,
      params: {
        uris: ['https://example.com/file.zip'],
        saveDir: '/d',
        filename: 'file.zip.motrix',
        connections: 8,
        headers: ['Authorization', 'Cookie'],
        proxy: 'http://proxy.example:8080',
        extraEngineOptions: {
          referer: 'https://origin.example/watch',
          'load-cookies': '[redacted-path]',
          'unknown-option': '[redacted]',
        },
      },
    })
    const dispatchFields = dispatch?.[0] as
      | { params: { gid: string } }
      | undefined
    expect(dispatchFields?.params.gid).toMatch(/^[0-9a-f]{16}$/)
  })

  it('redacts plugin-rewritten URIs without reducing the result to a count', async () => {
    const rewrittenSecret = 'REWRITTEN_URI_SECRET_753'
    const orchestrator = {
      runBeforeCreateHttp: vi.fn().mockResolvedValue({
        final: {
          type: 'http' as const,
          sourceUrl: 'https://original.example/file.zip',
          uris: [`https://cdn.example/file.zip?signature=${rewrittenSecret}`],
          saveDir: '/d',
          filename: 'file.zip',
          connections: undefined,
          headers: [],
          proxy: undefined,
          createdBy: 'user' as const,
          requestedAt: 0,
        },
        contributors: {
          headers: [],
          proxy: null,
          uris: 'plugin-rewriter',
        },
        staged: { commitMetadata: vi.fn() },
      }),
    } as unknown as Deps['orchestrator']

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://original.example/file.zip'],
        saveDir: '/d',
        filename: 'file.zip',
        headers: [],
      },
      { ...makeDeps(), orchestrator }
    )

    const resultLog = logInfo.mock.calls.find(
      (call) => call[1] === 'beforeCreate hook chain result'
    )
    expect(resultLog?.[0]).toMatchObject({
      rewrittenUris: ['https://cdn.example/file.zip'],
      contributors: { uris: 'plugin-rewriter' },
    })
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain(rewrittenSecret)
  })

  it('dispatches http request via rpcClient.addUri', async () => {
    const deps = makeDeps({ addUriGid: 'gid-x' })
    const result = await handleCreateTask(
      {
        type: 'http',
        uris: ['https://a/b'],
        saveDir: '/d',
        headers: [],
      },
      deps
    )
    expect(result.gid).toMatch(/^[0-9a-f]{16}$/)
    expect(typeof result.taskId).toBe('string')
    expect(result.taskId).not.toBe(result.gid)
    expect(deps.addUri).toHaveBeenCalledWith(
      ['https://a/b'],
      expect.objectContaining({ dir: '/d' })
    )
  })

  it('uses the host-prepared save directory for task and aria2 paths', async () => {
    const prepareSaveDir = vi.fn(async () => '/downloads/canonical')
    const deps = makeDeps({ prepareSaveDir })

    await handleCreateTask(httpRequest(), deps)

    expect(prepareSaveDir).toHaveBeenCalledWith('/d')
    expect(deps.pick).toHaveBeenCalledWith('/downloads/canonical', 'b')
    expect(deps.addUri).toHaveBeenCalledWith(
      ['https://a/b'],
      expect.objectContaining({ dir: '/downloads/canonical' })
    )
    expect(lastAddedTask(deps).saveDir).toBe('/downloads/canonical')
  })

  it('records one submitted event after canonical registration and before TaskUpdated', async () => {
    const deps = makeDeps({ addUriGid: 'gid-activity' })

    const result = await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/file.zip'],
        saveDir: '/d',
        headers: [],
      },
      deps
    )

    const task = lastAddedTask(deps)
    const recordSubmitted = deps.activityRecorder.recordSubmitted as ReturnType<
      typeof vi.fn
    >
    const emit = deps.eventBus.emit as ReturnType<typeof vi.fn>
    expect(recordSubmitted).toHaveBeenCalledOnce()
    expect(recordSubmitted).toHaveBeenCalledWith({
      taskId: result.taskId,
      occurredAt: task.createdAt,
    })
    expect(deps.add.mock.invocationCallOrder[0]).toBeLessThan(
      recordSubmitted.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(recordSubmitted.mock.invocationCallOrder[0]).toBeLessThan(
      emit.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('persists the parent and records Added before publishing the task', async () => {
    const deps = makeDeps({ addUriGid: 'gid-durable' })
    const order: string[] = []
    deps.add.mockImplementation(() => {
      order.push('publish')
    })
    const persistTask = vi.fn(async () => {
      order.push('persist-parent')
    })
    const parentTaskCreated = vi.fn(
      async (
        _task: DownloadTask,
        persistParent: () => void | Promise<void>
      ) => {
        await persistParent()
        order.push('record-added')
      }
    )

    await handleCreateTask(httpRequest(), {
      ...deps,
      persistTask,
      parentTaskCreated,
    })

    expect(order).toEqual(['persist-parent', 'record-added', 'publish'])
  })

  it('dispatches bt torrent via rpcClient.addTorrent', async () => {
    const deps = makeDeps({ addTorrentGid: 'gid-bt' })
    const result = await handleCreateTask(
      {
        type: 'bt',
        payload: { kind: 'torrent-base64', base64: 'AAAA' },
        selectedFiles: [0],
        saveDir: '/d',
        displayName: 'mytorrent',
      },
      deps
    )
    expect(result.gid).toMatch(/^[0-9a-f]{16}$/)
    expect(typeof result.taskId).toBe('string')
    expect(deps.addTorrent).toHaveBeenCalledWith(
      'AAAA',
      [],
      expect.objectContaining({ 'select-file': '1' })
    )
  })

  it('extracts torrent info.name when displayName is absent', async () => {
    // Hand-rolled minimal bencode torrent: single file "x", name = the
    // given string. Shape: d4:infod6:lengthi1024e4:name<N>:<name>
    //   12:piece lengthi16384e6:pieces20:<20 zero bytes>ee
    function buildMinimalTorrent(name: string): Uint8Array {
      const nameField = `4:name${Buffer.byteLength(name, 'utf8')}:${name}`
      const prefix = Buffer.from(
        `d4:infod6:lengthi1024e${nameField}12:piece lengthi16384e6:pieces20:`,
        'utf8'
      )
      const pieces = Buffer.alloc(20)
      const suffix = Buffer.from('ee', 'utf8')
      return new Uint8Array(Buffer.concat([prefix, pieces, suffix]))
    }

    const deps = makeDeps({ addTorrentGid: 'gid-bt' })
    const bytes = buildMinimalTorrent('ubuntu-25.10-desktop-amd64.iso')
    await handleCreateTask(
      {
        type: 'bt',
        payload: {
          kind: 'torrent-base64',
          base64: Buffer.from(bytes).toString('base64'),
        },
        selectedFiles: [0],
        saveDir: '/d',
        // no displayName — should derive from info.name
      },
      deps
    )
    const task = lastAddedTask(deps)
    expect(task.finalName).toBe('ubuntu-25.10-desktop-amd64.iso')
    expect(task.diskPath).toBe('/d/ubuntu-25.10-desktop-amd64.iso.motrix')
  })

  it('falls back to "torrent" literal when bytes are unparseable', async () => {
    const deps = makeDeps({ addTorrentGid: 'gid-bt' })
    await handleCreateTask(
      {
        type: 'bt',
        payload: { kind: 'torrent-base64', base64: 'AAAA' },
        selectedFiles: [0],
        saveDir: '/d',
        // no displayName, and 'AAAA' decodes to invalid bencode
      },
      deps
    )
    const task = lastAddedTask(deps)
    expect(task.finalName).toBe('torrent')
  })

  it('dispatches magnet via rpcClient.addUri', async () => {
    const deps = makeDeps({ addUriGid: 'gid-magnet' })
    const result = await handleCreateTask(
      {
        type: 'bt',
        payload: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:x' },
        selectedFiles: [0],
        saveDir: '/d',
        displayName: 'mag-name',
      },
      deps
    )
    expect(result.gid).toMatch(/^[0-9a-f]{16}$/)
    expect(typeof result.taskId).toBe('string')
    expect(deps.addUri).toHaveBeenCalledWith(
      ['magnet:?xt=urn:btih:x'],
      expect.any(Object)
    )
  })
})

describe('handleCreateTask with incomplete-suffix', () => {
  it('HTTP task: taskManager receives task with diskPath=.motrix, finalPath clean', async () => {
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/foo.mp4'],
        saveDir: '/d',
        filename: 'foo.mp4',
        headers: [],
      },
      deps
    )
    const task = lastAddedTask(deps)
    expect(task.diskPath).toBe('/d/foo.mp4.motrix')
    expect(task.finalPath).toBe('/d/foo.mp4')
    expect(task.finalName).toBe('foo.mp4')
    expect(task.filename).toBe('foo.mp4')
    expect(task.saveDir).toBe('/d')
    expect(task.transitionPhase).toBe(TransitionPhase.Idle)
    expect(task.type).toBe(TaskType.Http)
    expect(task.engineTaskId).toMatch(/^[0-9a-f]{16}$/)
    expect(task.torrentMetaPath).toBeNull()
  })

  it('HTTP task: overrides aria2 `out` to <finalName>.motrix inside the saveDir', async () => {
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/foo.mp4'],
        saveDir: '/d',
        filename: 'foo.mp4',
        headers: [],
      },
      deps
    )
    const [, options] = deps.addUri.mock.calls[0]
    expect(options.dir).toBe('/d')
    expect(options.out).toBe('foo.mp4.motrix')
  })

  it('BT task: taskManager receives task with diskPath=<saveDir>/<name>.motrix', async () => {
    const deps = makeDeps({
      persist: async (id) => `/torrents/${id}.torrent`,
    })
    await handleCreateTask(
      {
        type: 'bt',
        payload: { kind: 'torrent-base64', base64: 'AAAA' },
        selectedFiles: [0],
        saveDir: '/d',
        displayName: 'mytorrent',
        torrentBytes: new Uint8Array([1, 2, 3]),
      },
      deps
    )
    const task = lastAddedTask(deps)
    expect(task.diskPath).toBe('/d/mytorrent.motrix')
    expect(task.finalPath).toBe('/d/mytorrent')
    expect(task.finalName).toBe('mytorrent')
    expect(task.type).toBe(TaskType.Bt)
    expect(task.torrentMetaPath).toBe(`/torrents/${task.id}.torrent`)
  })

  it('BT task: aria2 `dir` option points at the .motrix container and `out` is dropped', async () => {
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'bt',
        payload: { kind: 'torrent-base64', base64: 'AAAA' },
        selectedFiles: [0],
        saveDir: '/d',
        displayName: 'mytorrent',
      },
      deps
    )
    const [, , options] = deps.addTorrent.mock.calls[0]
    expect(options.dir).toBe('/d/mytorrent.motrix')
    expect(options.out).toBeUndefined()
  })

  it('Magnet task: derives name from dn= when no displayName provided', async () => {
    const deps = makeDeps({ addUriGid: 'gid-m' })
    await handleCreateTask(
      {
        type: 'bt',
        payload: {
          kind: 'magnet',
          uri: 'magnet:?xt=urn:btih:deadbeef&dn=Ubuntu%2024.04',
        },
        selectedFiles: [0],
        saveDir: '/d',
      },
      deps
    )
    const task = lastAddedTask(deps)
    expect(task.finalName).toBe('Ubuntu 24.04')
    expect(task.diskPath).toBe('/d/Ubuntu 24.04.motrix')
    expect(task.type).toBe(TaskType.Magnet)
    // magnet payloads never persist torrentBytes
    expect(task.torrentMetaPath).toBeNull()
    expect(deps.persist).not.toHaveBeenCalled()
  })

  it('HTTP task: falls back to URI basename when filename absent', async () => {
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/path/archive.tar.gz'],
        saveDir: '/d',
        headers: [],
      },
      deps
    )
    expect(deps.pick).toHaveBeenCalledWith('/d', 'archive.tar.gz')
    const task = lastAddedTask(deps)
    expect(task.finalName).toBe('archive.tar.gz')
  })

  it('delegates to FinalNamePicker and uses returned dedup name', async () => {
    const deps = makeDeps({ pick: async () => 'foo (1).mp4' })
    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/foo.mp4'],
        saveDir: '/d',
        filename: 'foo.mp4',
        headers: [],
      },
      deps
    )
    expect(deps.pick).toHaveBeenCalledWith('/d', 'foo.mp4')
    const task = lastAddedTask(deps)
    expect(task.finalName).toBe('foo (1).mp4')
    expect(task.diskPath).toBe('/d/foo (1).mp4.motrix')
    expect(task.finalPath).toBe('/d/foo (1).mp4')
  })

  it('wraps TorrentMetaStore failure in TaskCreateTorrentMetaFailed', async () => {
    const deps = makeDeps({
      persist: async () => {
        throw new Error('disk full')
      },
    })
    try {
      await handleCreateTask(
        {
          type: 'bt',
          payload: { kind: 'torrent-base64', base64: 'AAAA' },
          selectedFiles: [0],
          saveDir: '/d',
          displayName: 'mytorrent',
        },
        deps
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe(ErrorCode.TaskCreateTorrentMetaFailed)
    }
    // engine is not called when meta persistence fails
    expect(deps.addTorrent).not.toHaveBeenCalled()
    expect(deps.add).not.toHaveBeenCalled()
  })

  it('propagates FinalNamePicker.pick rejection (TaskCreateDedupExhausted)', async () => {
    const deps = makeDeps({
      pick: async () => {
        throw new AppError(
          ErrorCode.TaskCreateDedupExhausted,
          'too many collisions'
        )
      },
    })
    await expect(
      handleCreateTask(
        {
          type: 'http',
          uris: ['https://a/b'],
          saveDir: '/d',
          filename: 'foo.mp4',
          headers: [],
        },
        deps
      )
    ).rejects.toMatchObject({ code: ErrorCode.TaskCreateDedupExhausted })
    expect(deps.addUri).not.toHaveBeenCalled()
    expect(deps.add).not.toHaveBeenCalled()
  })
})

describe('handleCreateTask mkdir target by task type', () => {
  // BT/Magnet: `diskPath` is the container directory aria2 populates,
  // and aria2.addTorrent writes `<sha1>.torrent` inside it at add time
  // — pre-creating the dir is required to keep that write from
  // silently failing (which would skip the sqlite3 task row and hit a
  // FK violation on the next pause).
  it('BT task: mkdirs the .motrix container (diskPath)', async () => {
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'bt',
        payload: { kind: 'torrent-base64', base64: 'AAAA' },
        selectedFiles: [0],
        saveDir: '/d',
        displayName: 'mytorrent',
      },
      deps
    )
    expect(mkdirMock).toHaveBeenCalledTimes(1)
    expect(mkdirMock).toHaveBeenCalledWith('/d/mytorrent.motrix', {
      recursive: true,
    })
  })

  it('Magnet task: mkdirs the .motrix container (diskPath)', async () => {
    const deps = makeDeps({ addUriGid: 'gid-m' })
    await handleCreateTask(
      {
        type: 'bt',
        payload: {
          kind: 'magnet',
          uri: 'magnet:?xt=urn:btih:deadbeef&dn=Ubuntu',
        },
        selectedFiles: [0],
        saveDir: '/d',
      },
      deps
    )
    expect(mkdirMock).toHaveBeenCalledTimes(1)
    expect(mkdirMock).toHaveBeenCalledWith('/d/Ubuntu.motrix', {
      recursive: true,
    })
  })

  // HTTP/FTP: `diskPath` IS the file path — mkdir'ing it would race
  // with aria2's open(2) for write (EISDIR). Pre-create the parent
  // saveDir instead so aria2's `dir` option is reachable.
  it('HTTP task: mkdirs the saveDir, NOT the .motrix file path', async () => {
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/foo.mp4'],
        saveDir: '/d',
        filename: 'foo.mp4',
        headers: [],
      },
      deps
    )
    expect(mkdirMock).toHaveBeenCalledTimes(1)
    expect(mkdirMock).toHaveBeenCalledWith('/d', { recursive: true })
    expect(mkdirMock).not.toHaveBeenCalledWith(
      '/d/foo.mp4.motrix',
      expect.anything()
    )
  })

  it('HTTP task: still proceeds when mkdir fails (defence-in-depth)', async () => {
    mkdirMock.mockRejectedValueOnce(new Error('EACCES'))
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/foo.mp4'],
        saveDir: '/d',
        filename: 'foo.mp4',
        headers: [],
      },
      deps
    )
    // engine still dispatched, task still registered
    expect(deps.addUri).toHaveBeenCalledOnce()
    expect(deps.add).toHaveBeenCalledOnce()
  })
})

describe('handleCreateTask isPrivate propagation', () => {
  it('persists isPrivate=true for a private torrent', async () => {
    const torrentBytes = makePrivateTorrentFixture()
    const deps = makeDeps({ addTorrentGid: 'gid-bt' })
    await handleCreateTask(
      {
        type: 'bt',
        payload: {
          kind: 'torrent-base64',
          base64: Buffer.from(torrentBytes).toString('base64'),
        },
        selectedFiles: [0],
        saveDir: '/d',
        displayName: 'private-torrent',
      },
      deps
    )
    const task = lastAddedTask(deps)
    expect(task.bt?.isPrivate).toBe(true)
  })

  it('persists isPrivate=false for a public torrent', async () => {
    const torrentBytes = makePublicTorrentFixture()
    const deps = makeDeps({ addTorrentGid: 'gid-bt' })
    await handleCreateTask(
      {
        type: 'bt',
        payload: {
          kind: 'torrent-base64',
          base64: Buffer.from(torrentBytes).toString('base64'),
        },
        selectedFiles: [0],
        saveDir: '/d',
        displayName: 'public-torrent',
      },
      deps
    )
    const task = lastAddedTask(deps)
    expect(task.bt?.isPrivate).toBe(false)
  })

  it('passes bt-tracker="" to addTorrent for private torrents', async () => {
    const torrentBytes = makePrivateTorrentFixture()
    const deps = makeDeps({ addTorrentGid: 'gid-bt' })
    await handleCreateTask(
      {
        type: 'bt',
        payload: {
          kind: 'torrent-base64',
          base64: Buffer.from(torrentBytes).toString('base64'),
        },
        selectedFiles: [0],
        saveDir: '/d',
        displayName: 'private-torrent',
      },
      deps
    )
    const addTorrentCall = deps.addTorrent.mock.calls[0]
    const opts = addTorrentCall[2] as Record<string, string>
    expect(opts['bt-tracker']).toBe('')
  })

  it('does not override bt-tracker for public torrents', async () => {
    const torrentBytes = makePublicTorrentFixture()
    const deps = makeDeps({ addTorrentGid: 'gid-bt' })
    await handleCreateTask(
      {
        type: 'bt',
        payload: {
          kind: 'torrent-base64',
          base64: Buffer.from(torrentBytes).toString('base64'),
        },
        selectedFiles: [0],
        saveDir: '/d',
        displayName: 'public-torrent',
      },
      deps
    )
    const addTorrentCall = deps.addTorrent.mock.calls[0]
    const opts = addTorrentCall[2] as Record<string, string>
    expect(opts['bt-tracker']).toBeUndefined()
  })
})

describe('handleCreateTask CreateTaskOptions', () => {
  it('persists source and sourceMeta when caller supplies them', async () => {
    const deps = makeDeps()
    const req = {
      type: 'http',
      uris: ['http://example.com/x.mp4'],
      saveDir: '/tmp/save',
      filename: 'x.mp4',
      connections: 1,
      headers: [],
    }
    await handleCreateTask(req, deps, {
      source: 'bridge',
      sourceMeta: {
        kind: 'direct',
        extensionId: 'e',
        browser: 'chromium',
        sessionKey: 'chromium:e',
        pageUrl: 'http://page',
        pageTitle: 't',
        qualityLabel: 'q',
        durationSec: null,
        submittedAt: 1,
      },
    })
    const task = lastAddedTask(deps)
    expect(task.source).toBe('bridge')
    expect(task.sourceMeta?.kind).toBe('direct')
  })

  it('merges extraEngineOptions into aria2.addUri options', async () => {
    const deps = makeDeps({ addUriGid: 'gid-x' })
    const req = {
      type: 'http',
      uris: ['http://example.com/y.mp4'],
      saveDir: '/tmp/save',
      filename: 'y.mp4',
      connections: 1,
      headers: [],
    }
    await handleCreateTask(req, deps, {
      extraEngineOptions: {
        header: ['X-A: 1', 'X-B: 2'],
        'load-cookies': '/tmp/jar.txt',
        referer: 'http://page',
      },
    })
    const [, options] = deps.addUri.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ]
    expect(options.header).toEqual(['X-A: 1', 'X-B: 2'])
    expect(options['load-cookies']).toBe('/tmp/jar.txt')
    expect(options.referer).toBe('http://page')
  })
})

describe('handleCreateTask plugin-hook chain (Plan C / T15)', () => {
  // Mocks the HookOrchestrator and HookAuditLog dependencies the production
  // code expects when the host has wired up the Plan C hook surface. The
  // staged-effect store can stay a real instance — it is plain data.
  function makeStaged() {
    return {
      commitMetadata: vi.fn((_db: unknown, _id: string, cb: () => void) => {
        cb()
      }),
    }
  }

  function makeOrchestrator(
    result:
      | ReturnType<typeof makeChainCommit>
      | { aborted: true; reason: string }
  ) {
    return {
      runBeforeCreateHttp: vi.fn().mockResolvedValue(result),
      runBeforeFinalize: vi.fn(),
      runParallel: vi.fn(),
    } as unknown as Deps['orchestrator']
  }

  function makeAuditLog() {
    return {
      log: vi.fn(async () => {}),
    } as unknown as Deps['auditLog']
  }

  function makeChainCommit(
    overrides: {
      uris?: string[]
      headers?: Array<{ name: string; value: string }>
      proxy?: string
      headerContributors?: string[]
      uriContributor?: string
      proxyContributor?: string
      staged?: ReturnType<typeof makeStaged>
    } = {}
  ) {
    const staged = overrides.staged ?? makeStaged()
    return {
      final: {
        type: 'http' as const,
        sourceUrl: overrides.uris?.[0] ?? 'https://a/b',
        uris: overrides.uris ?? ['https://a/b'],
        saveDir: '/d',
        filename: 'b',
        connections: undefined,
        headers: overrides.headers ?? [],
        proxy: overrides.proxy,
        createdBy: 'user' as const,
        requestedAt: 0,
      },
      contributors: {
        headers: overrides.headerContributors ?? [],
        proxy: overrides.proxyContributor,
        uris: overrides.uriContributor,
      },
      staged,
    }
  }

  it('uses merged uris and headers from the chain when present', async () => {
    const orchestrator = makeOrchestrator(
      makeChainCommit({
        uris: ['https://cdn.example/b'],
        headers: [
          { name: 'X-Plugin', value: 'on' },
          { name: 'User-Agent', value: 'rewritten' },
        ],
        proxy: 'http://proxy.example:1080',
        headerContributors: ['plugin-a'],
        uriContributor: 'plugin-a',
        proxyContributor: 'plugin-a',
      })
    )
    const auditLog = makeAuditLog()
    const deps = makeDeps({ addUriGid: 'gid-x' })
    const fullDeps = {
      ...deps,
      orchestrator,
      auditLog,
    }

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://a/b'],
        saveDir: '/d',
        headers: [],
      },
      fullDeps
    )

    expect(orchestrator?.runBeforeCreateHttp).toHaveBeenCalledOnce()
    const [, options] = deps.addUri.mock.calls[0]
    expect(deps.addUri.mock.calls[0][0]).toEqual(['https://cdn.example/b'])
    expect(options.header).toEqual(['X-Plugin: on', 'User-Agent: rewritten'])
    expect(options['all-proxy']).toBe('http://proxy.example:1080')
    expect(auditLog?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chain.commit',
        hook: 'beforeCreate',
        headerContributors: ['plugin-a'],
        proxyContributor: 'plugin-a',
        uriContributor: 'plugin-a',
        finalHeaderCount: 2,
      })
    )
  })

  it('commits staged metadata inside the same transaction as task add', async () => {
    const staged = makeStaged()
    const orchestrator = makeOrchestrator(
      makeChainCommit({ staged, headerContributors: ['p'] })
    )
    const auditLog = makeAuditLog()
    // Sentinel db object; we only verify commitMetadata is called with it
    // and that the task add happens inside the supplied callback.
    const db = { _sentinel: true } as unknown as Deps['db']
    const deps = makeDeps()
    const fullDeps = { ...deps, orchestrator, auditLog, db }

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://a/b'],
        saveDir: '/d',
        headers: [],
      },
      fullDeps
    )

    expect(staged.commitMetadata).toHaveBeenCalledOnce()
    const [dbArg, idArg, cb] = staged.commitMetadata.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(typeof idArg).toBe('string')
    expect(typeof cb).toBe('function')
    // The taskManager.add must have run inside the callback (already
    // invoked by our makeStaged stub).
    expect(deps.add).toHaveBeenCalledOnce()
  })

  it('throws PluginRuntimeFault and emits chain.abort when chain aborts', async () => {
    const orchestrator = makeOrchestrator({ aborted: true, reason: 'boom' })
    const auditLog = makeAuditLog()
    const deps = makeDeps()
    const fullDeps = { ...deps, orchestrator, auditLog }

    await expect(
      handleCreateTask(
        {
          type: 'http',
          uris: ['https://a/b'],
          saveDir: '/d',
          headers: [],
        },
        fullDeps
      )
    ).rejects.toMatchObject({ code: ErrorCode.PluginRuntimeFault })

    expect(auditLog?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chain.abort',
        hook: 'beforeCreate',
        reason: 'boom',
      })
    )
    // engine never dispatched, task never registered
    expect(deps.addUri).not.toHaveBeenCalled()
    expect(deps.add).not.toHaveBeenCalled()
  })

  it('skips the chain for BT tasks (out of scope for T15)', async () => {
    const orchestrator = makeOrchestrator(makeChainCommit())
    const deps = makeDeps()
    const fullDeps = { ...deps, orchestrator }

    await handleCreateTask(
      {
        type: 'bt',
        payload: { kind: 'torrent-base64', base64: 'AAAA' },
        selectedFiles: [0],
        saveDir: '/d',
        displayName: 'mytorrent',
      },
      fullDeps
    )

    expect(orchestrator?.runBeforeCreateHttp).not.toHaveBeenCalled()
    expect(deps.addTorrent).toHaveBeenCalledOnce()
  })

  it('emits chain.commit even when only proxy/uri changed (no header contributors)', async () => {
    // Regression: previously, the chain.commit emission was gated on
    // headerContributors.length > 0, which silently dropped audit lines
    // for chains that mutate only `uris` or `proxy`. Successful chains
    // must always leave an audit trail.
    const orchestrator = makeOrchestrator(
      makeChainCommit({
        uris: ['https://cdn.example/b'],
        proxy: 'http://proxy.example:1080',
        headerContributors: [],
        uriContributor: 'plugin-b',
        proxyContributor: 'plugin-b',
      })
    )
    const auditLog = makeAuditLog()
    const deps = makeDeps({ addUriGid: 'gid-y' })
    const fullDeps = { ...deps, orchestrator, auditLog }

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://a/b'],
        saveDir: '/d',
        headers: [],
      },
      fullDeps
    )

    expect(auditLog?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chain.commit',
        hook: 'beforeCreate',
        headerContributors: [],
        proxyContributor: 'plugin-b',
        uriContributor: 'plugin-b',
        finalHeaderCount: 0,
      })
    )
  })
})

describe('handleCreateTask engine-ready gate', () => {
  it('awaits waitForEngineReady before dispatching to the engine (http)', async () => {
    const order: string[] = []
    const waitForEngineReady = vi.fn(async () => {
      order.push('gate')
    })
    const deps = makeDeps({ waitForEngineReady })
    deps.addUri.mockImplementation(async (_uris, options) => {
      order.push('adapter')
      return String(options.gid)
    })
    await handleCreateTask(httpRequest(), deps)
    expect(waitForEngineReady).toHaveBeenCalledOnce()
    expect(order).toEqual(['gate', 'adapter'])
  })

  it('throws and does NOT call the adapter when the gate rejects', async () => {
    const waitForEngineReady = vi.fn(async () => {
      throw new AppError(
        ErrorCode.EngineTimeout,
        'engine not ready within 15000ms'
      )
    })
    const deps = makeDeps({ waitForEngineReady })
    await expect(handleCreateTask(httpRequest(), deps)).rejects.toMatchObject({
      code: ErrorCode.EngineTimeout,
    })
    expect(deps.addUri).not.toHaveBeenCalled()
  })

  it('does not await the gate for an invalid payload (gate runs after validation)', async () => {
    const waitForEngineReady = vi.fn(async () => {})
    const deps = makeDeps({ waitForEngineReady })
    await expect(
      handleCreateTask({ type: 'nonsense' }, deps)
    ).rejects.toMatchObject({
      code: ErrorCode.IpcInvalidPayload,
    })
    expect(waitForEngineReady).not.toHaveBeenCalled()
  })

  it('creates normally when no gate is provided (back-compat)', async () => {
    const deps = makeDeps()
    const { taskId } = await handleCreateTask(httpRequest(), deps)
    expect(typeof taskId).toBe('string')
    expect(deps.addUri).toHaveBeenCalledOnce()
  })
})

describe('handleCreateTask reserved-GID ownership', () => {
  const reservedGid = '0123456789abcdef'

  it('persists a reserved owner before the engine can expose its gid', async () => {
    const order: string[] = []
    const deps = makeDeps()
    const persistTask = vi.fn(async (task: DownloadTask) => {
      expect(task.engineTaskId).toBe(reservedGid)
      order.push('persist')
    })
    deps.setReservedEngineTaskOwner.mockImplementation(() => {
      order.push('reserved-owner')
    })
    deps.addUri.mockImplementation(
      async (_uris: string[], options: Record<string, unknown>) => {
        expect(options.gid).toBe(reservedGid)
        expect(deps.reserveEngineTaskId).toHaveBeenCalledWith(reservedGid)
        expect(persistTask).toHaveBeenCalledOnce()
        expect(deps.setReservedEngineTaskOwner).toHaveBeenCalledOnce()
        expect(deps.add).not.toHaveBeenCalled()
        order.push('engine')
        return reservedGid
      }
    )
    deps.add.mockImplementation(() => {
      order.push('publish')
    })

    await handleCreateTask(httpRequest(), {
      ...deps,
      persistTask,
      createEngineTaskId: () => reservedGid,
    } as Deps)

    expect(order).toEqual(['persist', 'reserved-owner', 'engine', 'publish'])
  })

  it('holds the public task mutation admission across engine dispatch', async () => {
    const deps = makeDeps()
    let releaseEngine: (() => void) | undefined
    let engineEntered: (() => void) | undefined
    const engineGate = new Promise<void>((resolve) => {
      releaseEngine = resolve
    })
    const entered = new Promise<void>((resolve) => {
      engineEntered = resolve
    })
    deps.addUri.mockImplementation(async (_uris, options) => {
      engineEntered?.()
      await engineGate
      return String(options.gid)
    })
    let mutationTail: Promise<unknown> = Promise.resolve()
    const runTaskMutation = vi.fn(
      <T>(_taskIds: readonly string[], operation: () => Promise<T>) => {
        const result = mutationTail.then(operation)
        mutationTail = result.catch(() => undefined)
        return result
      }
    )
    let taskId = ''
    const creating = handleCreateTask(httpRequest(), {
      ...deps,
      persistTask: vi.fn(async (task) => {
        taskId = task.id
      }),
      rollbackTaskCreation: vi.fn(async () => {}),
      createEngineTaskId: () => reservedGid,
      runTaskMutation,
    } as Deps)

    await entered
    let competingMutationRan = false
    const competing = runTaskMutation([taskId], async () => {
      competingMutationRan = true
    })
    await Promise.resolve()
    expect(competingMutationRan).toBe(false)

    releaseEngine?.()
    await creating
    await competing
    expect(competingMutationRan).toBe(true)
  })

  it('does not dispatch and releases the reservation when the durable intent rejects', async () => {
    const deps = makeDeps()
    const failure = new Error('durable intent failed')

    await expect(
      handleCreateTask(httpRequest(), {
        ...deps,
        persistTask: vi.fn(async () => {
          throw failure
        }),
        rollbackTaskCreation: vi.fn(async () => {}),
        createEngineTaskId: () => reservedGid,
      } as Deps)
    ).rejects.toBe(failure)

    expect(deps.addUri).not.toHaveBeenCalled()
    expect(deps.releaseEngineTaskIdReservation).toHaveBeenCalledWith(
      reservedGid
    )
    expect(deps.retireEngineTaskIdReservation).not.toHaveBeenCalled()
  })

  it('retires rather than releases a cleaned-up post-dispatch reservation', async () => {
    const deps = makeDeps()
    const failure = new Error('transport lost after accept')
    deps.addUri.mockRejectedValue(failure)
    const rollbackTaskCreation = vi.fn(async () => {})
    let taskId = ''

    await expect(
      handleCreateTask(httpRequest(), {
        ...deps,
        persistTask: vi.fn(async (task) => {
          taskId = task.id
        }),
        rollbackTaskCreation,
        createEngineTaskId: () => reservedGid,
      } as Deps)
    ).rejects.toBe(failure)

    expect(deps.forceRemove).toHaveBeenCalledWith(reservedGid)
    expect(deps.removeDownloadResult).toHaveBeenCalledWith(reservedGid)
    expect(rollbackTaskCreation).toHaveBeenCalledWith(taskId)
    expect(deps.remove).toHaveBeenCalledWith(taskId)
    expect(deps.retireEngineTaskIdReservation).toHaveBeenCalledWith(reservedGid)
    expect(deps.releaseEngineTaskIdReservation).not.toHaveBeenCalled()
    expect(deps.setReservedEngineTaskOwner).toHaveBeenCalledOnce()
    expect(deps.add).not.toHaveBeenCalled()
  })

  it('publishes the durable candidate when post-dispatch cleanup is uncertain', async () => {
    const deps = makeDeps()
    const failure = new Error('transport lost after accept')
    deps.addUri.mockRejectedValue(failure)
    deps.forceRemove.mockRejectedValue(new Error('cleanup transport lost'))
    deps.removeDownloadResult.mockRejectedValue(
      new Error('result cleanup transport lost')
    )
    const rollbackTaskCreation = vi.fn(async () => {})

    await expect(
      handleCreateTask(httpRequest(), {
        ...deps,
        persistTask: vi.fn(async () => {}),
        rollbackTaskCreation,
        createEngineTaskId: () => reservedGid,
      } as Deps)
    ).rejects.toBe(failure)

    const owner = lastAddedTask(deps)
    expect(owner.engineTaskId).toBe(reservedGid)
    expect(rollbackTaskCreation).not.toHaveBeenCalled()
    expect(deps.releaseEngineTaskIdReservation).not.toHaveBeenCalled()
    expect(deps.retireEngineTaskIdReservation).not.toHaveBeenCalled()
  })
})

// ─── Characterization: aria2 RPC args ────────────────────────────────────────
//
// These tests pin the EXACT wire arguments that reach rpcClient.addUri /
// rpcClient.addTorrent today. They are the regression net for the whole
// EngineAdapter refactor: they MUST keep passing byte-for-byte after every
// subsequent task. Any drift in a key name, value string, or positional arg
// must cause a failure here.

describe('characterization: aria2 RPC args', () => {
  // (a) Plain HTTP: dir + out(.motrix) only, no header/proxy/split keys
  it('HTTP plain: dir=saveDir, out=basename.motrix, no header/proxy/split keys', async () => {
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/file.zip'],
        saveDir: '/dl',
        filename: 'file.zip',
        headers: [],
      },
      deps
    )
    expect(deps.addUri).toHaveBeenCalledOnce()
    const [uris, options] = deps.addUri.mock.calls[0] as [
      string[],
      Record<string, unknown>,
    ]
    expect(uris).toEqual(['https://example.com/file.zip'])
    expect(options.dir).toBe('/dl')
    expect(options.out).toBe('file.zip.motrix')
    // No connection keys when connections is absent
    expect(options.split).toBeUndefined()
    expect(options['max-connection-per-server']).toBeUndefined()
    // No header/proxy keys when not provided
    expect(options.header).toBeUndefined()
    expect(options['all-proxy']).toBeUndefined()
  })

  // (b) HTTP with headers + proxy + connections (clamped to maxConnectionPerServer=16)
  it('HTTP full: connections clamped to 16, header array, all-proxy, out=.motrix', async () => {
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/file.zip'],
        saveDir: '/dl',
        filename: 'file.zip',
        connections: 64, // clamped to maxConnectionPerServer=16
        headers: [{ name: 'Cookie', value: 'a=b' }],
        proxy: 'http://p:1080',
      },
      deps
    )
    expect(deps.addUri).toHaveBeenCalledOnce()
    const [uris, options] = deps.addUri.mock.calls[0] as [
      string[],
      Record<string, unknown>,
    ]
    expect(uris).toEqual(['https://example.com/file.zip'])
    expect(options.dir).toBe('/dl')
    expect(options.out).toBe('file.zip.motrix')
    // connections: min(64, 16) = 16, both keys identical string
    expect(options.split).toBe('16')
    expect(options['max-connection-per-server']).toBe('16')
    expect(options.split).toBe(options['max-connection-per-server'])
    expect(options.header).toEqual(['Cookie: a=b'])
    expect(options['all-proxy']).toBe('http://p:1080')
  })

  // (b-extra) HTTP with extraEngineOptions merged in after applyPathOverrides
  it('HTTP extraEngineOptions: referer and load-cookies land in addUri options', async () => {
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/video.mp4'],
        saveDir: '/dl',
        filename: 'video.mp4',
        headers: [],
      },
      deps,
      {
        extraEngineOptions: {
          referer: 'https://referrer.example',
          'load-cookies': '/tmp/cookies.txt',
        },
      }
    )
    expect(deps.addUri).toHaveBeenCalledOnce()
    const [uris, options] = deps.addUri.mock.calls[0] as [
      string[],
      Record<string, unknown>,
    ]
    expect(uris).toEqual(['https://example.com/video.mp4'])
    expect(options.dir).toBe('/dl')
    expect(options.out).toBe('video.mp4.motrix')
    expect(options.referer).toBe('https://referrer.example')
    expect(options['load-cookies']).toBe('/tmp/cookies.txt')
  })

  // (c) HTTP rewritten by beforeCreate plugin chain
  it('HTTP plugin rewrite: rewritten uris/headers/proxy reach addUri', async () => {
    const staged = {
      commitMetadata: vi.fn((_db: unknown, _id: string, cb: () => void) => {
        cb()
      }),
    }
    const orchestrator = {
      runBeforeCreateHttp: vi.fn().mockResolvedValue({
        final: {
          type: 'http' as const,
          sourceUrl: 'https://original.example/file.zip',
          uris: ['https://cdn.example/file-rewritten.zip'],
          saveDir: '/dl',
          filename: 'file.zip',
          connections: undefined,
          headers: [
            { name: 'X-Token', value: 'secret' },
            { name: 'Referer', value: 'https://original.example' },
          ],
          proxy: 'http://plugin-proxy:8888',
          createdBy: 'user' as const,
          requestedAt: 0,
        },
        contributors: {
          headers: ['plugin-rewriter'],
          proxy: 'plugin-rewriter',
          uris: 'plugin-rewriter',
        },
        staged,
      }),
      runBeforeFinalize: vi.fn(),
      runParallel: vi.fn(),
    } as unknown as Deps['orchestrator']
    const auditLog = {
      log: vi.fn(async () => {}),
    } as unknown as Deps['auditLog']
    const deps = makeDeps()
    const fullDeps = { ...deps, orchestrator, auditLog }

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://original.example/file.zip'],
        saveDir: '/dl',
        filename: 'file.zip',
        headers: [],
      },
      fullDeps
    )

    expect(deps.addUri).toHaveBeenCalledOnce()
    const [uris, options] = deps.addUri.mock.calls[0] as [
      string[],
      Record<string, unknown>,
    ]
    // Rewritten URI from plugin
    expect(uris).toEqual(['https://cdn.example/file-rewritten.zip'])
    // Headers from plugin chain (serialized to "Name: value")
    expect(options.header).toEqual([
      'X-Token: secret',
      'Referer: https://original.example',
    ])
    // Proxy from plugin chain
    expect(options['all-proxy']).toBe('http://plugin-proxy:8888')
    // Path overrides still applied by createTaskHandler
    expect(options.dir).toBe('/dl')
    expect(options.out).toBe('file.zip.motrix')
  })

  // (d) BT .torrent with selectedFiles (0-based → 1-based) + private torrent
  it('BT private torrent: select-file is 1-based, bt-tracker="", dir=diskPath, no out', async () => {
    const torrentBytes = makePrivateTorrentFixture()
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'bt',
        payload: {
          kind: 'torrent-base64',
          base64: Buffer.from(torrentBytes).toString('base64'),
        },
        saveDir: '/dl',
        displayName: 'private-torrent',
        selectedFiles: [0, 2], // 0-based → aria2 expects '1,3'
      },
      deps
    )
    expect(deps.addTorrent).toHaveBeenCalledOnce()
    const [base64, extraUris, options] = deps.addTorrent.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ]
    // Positional arg 0: the base64 payload (same as request)
    expect(base64).toBe(Buffer.from(torrentBytes).toString('base64'))
    // Positional arg 1: extra uris — always empty for .torrent
    expect(extraUris).toEqual([])
    // LANDMINE: selectedFiles are 0-based in request, 1-based in aria2 wire format
    expect(options['select-file']).toBe('1,3')
    // Private torrent: bt-tracker forced to empty string
    expect(options['bt-tracker']).toBe('')
    // BT dir = diskPath = saveDir/displayName.motrix
    expect(options.dir).toBe('/dl/private-torrent.motrix')
    // No `out` for BT tasks
    expect(options.out).toBeUndefined()
  })

  // (e) Magnet: dispatched via addUri with the magnet URI as-is
  it('magnet: dispatched via addUri, dir=diskPath, no out, no bt-tracker override', async () => {
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'bt',
        payload: {
          kind: 'magnet',
          uri: 'magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd&dn=TestFile',
        },
        saveDir: '/dl',
        selectedFiles: [],
        displayName: 'TestFile',
      },
      deps
    )
    expect(deps.addUri).toHaveBeenCalledOnce()
    expect(deps.addTorrent).not.toHaveBeenCalled()
    const [uris, options] = deps.addUri.mock.calls[0] as [
      string[],
      Record<string, unknown>,
    ]
    // URI is the raw magnet string
    expect(uris).toEqual([
      'magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd&dn=TestFile',
    ])
    // dir = diskPath for magnet (BT-like)
    expect(options.dir).toBe('/dl/TestFile.motrix')
    // No `out` for magnet tasks
    expect(options.out).toBeUndefined()
    // No bt-tracker override for magnet (only applied when isPrivateFromTorrent)
    expect(options['bt-tracker']).toBeUndefined()
    // No select-file for magnet (selectedFiles is empty)
    expect(options['select-file']).toBeUndefined()
  })

  // (f) Magnet WITH selectedFiles: pins the 1-based select-file wire that the
  // pre-refactor `addUri` path produced but no test previously asserted.
  it('magnet with selectedFiles: 1-based select-file via createDownload, dir=diskPath', async () => {
    const deps = makeDeps({ addUriGid: 'gid-m' })
    await handleCreateTask(
      {
        type: 'bt',
        payload: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:x&dn=Mag' },
        selectedFiles: [0, 2],
        saveDir: '/d',
        displayName: 'Mag',
      },
      deps
    )
    const [uris, options] = deps.addUri.mock.calls[0] as [
      string[],
      Record<string, unknown>,
    ]
    expect(uris).toEqual(['magnet:?xt=urn:btih:x&dn=Mag'])
    // 0-based [0,2] → 1-based wire
    expect(options['select-file']).toBe('1,3')
    // diskPath
    expect(options.dir).toBe('/d/Mag.motrix')
    expect(options.out).toBeUndefined()
  })
})

describe('handleCreateTask mux pre-resolve seam', () => {
  it('routes http to dispatchMux (not engine) when resolveToMux returns a mux pair', async () => {
    const muxPair = {
      videoUrl: 'https://video.example/v.mp4',
      audioUrl: 'https://audio.example/a.m4a',
      container: 'mp4' as const,
      headers: { 'x-test': 'yes' },
    }
    const resolveToMux = vi.fn().mockResolvedValue(muxPair)
    const dispatchMux = vi.fn().mockResolvedValue({ taskId: 'mux-task-id' })
    const deps = makeDeps()
    const result = await handleCreateTask(
      {
        type: 'http',
        uris: ['https://www.youtube.com/watch?v=abc'],
        saveDir: '/d',
        headers: [],
      },
      { ...deps, resolveToMux, dispatchMux }
    )
    // dispatchMux was called, NOT the engine
    expect(dispatchMux).toHaveBeenCalledOnce()
    expect(deps.addUri).not.toHaveBeenCalled()
    // taskId is reused from the mux pipeline result
    expect(result.taskId).toBe('mux-task-id')
    // dispatchMux received an AdaptedMux with the mux pair's fields
    const adapted = dispatchMux.mock.calls[0][0]
    expect(adapted.kind).toBe('mux')
    expect(adapted.videoUrl).toBe(muxPair.videoUrl)
    expect(adapted.audioUrl).toBe(muxPair.audioUrl)
    expect(adapted.container).toBe('mp4')
  })

  it("uses the resolver's title (sanitized) as the mux finalName, not the URL bvid", async () => {
    const resolveToMux = vi.fn().mockResolvedValue({
      videoUrl: 'https://v/v.mp4',
      audioUrl: 'https://a/a.m4a',
      container: 'mp4' as const,
      title: '9.9分！风道机箱唯一真神：酷冷 HAF II 500',
    })
    const dispatchMux = vi.fn().mockResolvedValue({ taskId: 't' })
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://www.bilibili.com/video/BV14vJg6ZEd4/'],
        saveDir: '/d',
        headers: [],
      },
      { ...deps, resolveToMux, dispatchMux }
    )
    const adapted = dispatchMux.mock.calls[0][0]
    // Full-width ！/： are not filesystem-illegal, so they survive. The point:
    // the human title is used, NOT the meaningless "BV14vJg6ZEd4" bvid — and
    // the container extension is appended BEFORE the dedup pick so the picked
    // name is the on-disk name.
    expect(adapted.finalName).toBe(
      '9.9分！风道机箱唯一真神：酷冷 HAF II 500.mp4'
    )
  })

  it('replaces filesystem-illegal characters in the resolver title', async () => {
    const resolveToMux = vi.fn().mockResolvedValue({
      videoUrl: 'https://v/v.mp4',
      audioUrl: 'https://a/a.m4a',
      container: 'mp4' as const,
      title: 'A/B: C? "D" <E>',
    })
    const dispatchMux = vi.fn().mockResolvedValue({ taskId: 't' })
    const deps = makeDeps()
    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://www.bilibili.com/video/BV14vJg6ZEd4/'],
        saveDir: '/d',
        headers: [],
      },
      { ...deps, resolveToMux, dispatchMux }
    )
    const adapted = dispatchMux.mock.calls[0][0]
    expect(adapted.finalName).toBe('A_B_ C_ _D_ _E_.mp4')
  })

  it('reuses the computed taskId when dispatching via mux', async () => {
    const resolveToMux = vi.fn().mockResolvedValue({
      videoUrl: 'https://v.example/v',
      audioUrl: 'https://a.example/a',
      container: 'mp4' as const,
    })
    let capturedTaskId: string | undefined
    const dispatchMux = vi.fn().mockImplementation(async (adapted) => {
      capturedTaskId = adapted.taskId
      return { taskId: adapted.taskId }
    })
    const deps = makeDeps()
    const result = await handleCreateTask(
      {
        type: 'http',
        uris: ['https://www.youtube.com/watch?v=xyz'],
        saveDir: '/d',
        headers: [],
      },
      { ...deps, resolveToMux, dispatchMux }
    )
    expect(capturedTaskId).toBe(result.taskId)
    expect(typeof capturedTaskId).toBe('string')
  })

  it('falls through to the normal HTTP path (engine.createDownload) when resolveToMux returns null', async () => {
    const resolveToMux = vi.fn().mockResolvedValue(null)
    const dispatchMux = vi.fn()
    const deps = makeDeps({ addUriGid: 'gid-http' })
    const result = await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/file.zip'],
        saveDir: '/d',
        headers: [],
      },
      { ...deps, resolveToMux, dispatchMux }
    )
    expect(deps.addUri).toHaveBeenCalledOnce()
    expect(dispatchMux).not.toHaveBeenCalled()
    expect(result.gid).toMatch(/^[0-9a-f]{16}$/)
  })

  it('falls through to HTTP path when resolveToMux and dispatchMux are absent', async () => {
    const deps = makeDeps({ addUriGid: 'gid-fallback' })
    const result = await handleCreateTask(
      {
        type: 'http',
        uris: ['https://www.youtube.com/watch?v=test'],
        saveDir: '/d',
        headers: [],
      },
      deps
    )
    expect(deps.addUri).toHaveBeenCalledOnce()
    expect(result.gid).toMatch(/^[0-9a-f]{16}$/)
  })

  it('never calls resolveToMux for magnet/bt requests', async () => {
    const resolveToMux = vi.fn().mockResolvedValue(null)
    const dispatchMux = vi.fn()
    const deps = makeDeps({ addUriGid: 'gid-m' })
    await handleCreateTask(
      {
        type: 'bt',
        payload: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:abc&dn=Test' },
        selectedFiles: [],
        saveDir: '/d',
      },
      { ...deps, resolveToMux, dispatchMux }
    )
    expect(resolveToMux).not.toHaveBeenCalled()
    expect(dispatchMux).not.toHaveBeenCalled()
    expect(deps.addUri).toHaveBeenCalledOnce()
  })
})
