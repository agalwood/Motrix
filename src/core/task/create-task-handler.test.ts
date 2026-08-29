import { initLogger } from '@core/logger'
import {
  AppliedDownloadProxyPolicy,
  type AppliedDownloadProxySnapshot,
} from '@core/proxy/applied-download-proxy-policy'
import { proxyToDownloadRequestOptions } from '@core/proxy/serializers'
import { AppError, ErrorCode } from '@shared/errors'
import { DEFAULT_ENGINE_SETTINGS } from '@shared/schemas/engine-settings'
import { DEFAULT_PROXY_SETTINGS } from '@shared/schemas/proxy-settings'
import type { EngineFeatureReport } from '@shared/types/engine'
import type { ProxySettings } from '@shared/types/settings'
import type { DownloadTask } from '@shared/types/task'
import {
  makeDefaultBtExtension,
  makeDownloadTask,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Aria2Adapter } from '../engine/aria2/aria2-adapter'
import { DIRECT_RESOURCE_METADATA_PROFILE } from '../engine/engine-adapter'
import { parseBtFileLayout } from './bt-storage-layout'
import { handleCreateTask } from './create-task-handler'
import { sanitizeRemoteFilename } from './direct-resource-validator'
import { FinalNamePickerImpl } from './final-name-picker'

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
  proxySettings?: ProxySettings
  appliedProxySnapshot?: AppliedDownloadProxySnapshot
  engineUserAgent?: string
  engineFeatureReport?: EngineFeatureReport
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
  // Route the create path through a real Aria2Adapter wrapping mock RPC
  // spies so handler tests cover the integration boundary. The three `on*`
  // subscriptions are required by the constructor and are no-op stubs here.
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
  adapter.setDirectResourceMetadataProfile(DIRECT_RESOURCE_METADATA_PROFILE)
  if (overrides.engineFeatureReport) {
    adapter.setFeatureReport(overrides.engineFeatureReport)
  }
  const settingsManager = {
    getApp: () => ({
      defaultSaveDir: overrides.defaultSaveDir ?? '/fallback',
    }),
    getEngine: () => ({
      performanceProfile: DEFAULT_ENGINE_SETTINGS.performanceProfile,
      maxConnectionPerServer: DEFAULT_ENGINE_SETTINGS.maxConnectionPerServer,
      userAgent: overrides.engineUserAgent,
    }),
    getProxy: () => overrides.proxySettings ?? DEFAULT_PROXY_SETTINGS,
  } as unknown as Deps['settingsManager']
  const configuredRequestProxy = proxyToDownloadRequestOptions(
    overrides.proxySettings ?? DEFAULT_PROXY_SETTINGS
  )
  const appliedProxySnapshot = Object.hasOwn(overrides, 'appliedProxySnapshot')
    ? (overrides.appliedProxySnapshot ?? null)
    : (configuredRequestProxy ?? { noProxy: '' })
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
    getAll: vi.fn(() => []),
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
    directResourceProxyPolicy: new AppliedDownloadProxyPolicy(
      appliedProxySnapshot
    ),
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
  it('reuses an exact active torrent before allocating storage or an engine gid', async () => {
    const bytes = makePublicTorrentFixture()
    const parsed = await parseBtFileLayout(bytes)
    const deps = makeDeps()
    const existing = makeDownloadTask({
      id: 'existing-task',
      engineTaskId: 'existing-gid',
      name: 'public-torrent',
      kind: TaskKind.Bt,
      type: TaskType.Bt,
      status: TaskStatus.Seeding,
      saveDir: '/d',
      createdAt: 1,
      updatedAt: 1,
      filename: 'public-torrent',
      diskPath: '/d/public-torrent',
      finalPath: '/d/public-torrent',
      finalName: 'public-torrent',
      infoHash: parsed.infoHash,
      bt: makeDefaultBtExtension({ selectedFiles: [0] }),
      source: 'user',
      sourceMeta: null,
      instances: [
        {
          instanceId: 'primary:existing-task',
          motrixId: 'existing-task',
          gid: 'existing-gid',
          phase: TaskInstancePhase.BtDownload,
          status: TaskStatus.Seeding,
          progress: 1,
          totalBytes: 1024,
          downloadedBytes: 1024,
          uploadedBytes: 0,
          diskPath: '/d/public-torrent',
          transitionPhase: TransitionPhase.Idle,
          uris: [],
          uriHash: null,
          payload: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    vi.mocked(deps.taskManager.getAll).mockReturnValue([existing])
    vi.mocked(deps.taskManager.getById).mockReturnValue(existing)

    await expect(
      handleCreateTask(
        {
          type: 'bt',
          payload: {
            kind: 'torrent-base64',
            base64: Buffer.from(bytes).toString('base64'),
          },
          selectedFiles: [0],
          saveDir: '/d',
        },
        deps
      )
    ).resolves.toEqual({
      outcome: 'reused',
      gid: 'existing-gid',
      taskId: 'existing-task',
    })
    expect(deps.addTorrent).not.toHaveBeenCalled()
    expect(deps.pick).not.toHaveBeenCalled()
    expect(deps.persist).not.toHaveBeenCalled()
  })

  it('does not silently suffix orphaned torrent files without confirmation', async () => {
    const bytes = makePublicTorrentFixture()
    const deps = makeDeps()
    deps.finalNamePicker.isTaken = vi.fn(async () => true)

    await expect(
      handleCreateTask(
        {
          type: 'bt',
          payload: {
            kind: 'torrent-base64',
            base64: Buffer.from(bytes).toString('base64'),
          },
          selectedFiles: [0],
          saveDir: '/d',
        },
        deps
      )
    ).rejects.toMatchObject({
      conflict: { reason: 'existing-files', canCreateCopy: true },
    })
    expect(deps.addTorrent).not.toHaveBeenCalled()
    expect(deps.pick).not.toHaveBeenCalled()
    expect(deps.persist).not.toHaveBeenCalled()
  })

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

    const deps = makeDeps()
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
      deps,
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
      saveDir: '/d',
      filename: 'file.zip.motrix',
      connections: 8,
    })
    const dispatchFields = dispatch?.[0] as
      | { gid: string; params?: unknown; uris?: unknown; headers?: unknown }
      | undefined
    expect(dispatchFields?.gid).toMatch(/^[0-9a-f]{16}$/)
    expect(dispatchFields).not.toHaveProperty('params')
    expect(dispatchFields).not.toHaveProperty('uris')
    expect(dispatchFields).not.toHaveProperty('headers')
    expect(dispatchFields).not.toHaveProperty('proxy')
    expect(dispatchFields).not.toHaveProperty('extraEngineOptions')

    const taskPayload = lastAddedTask(deps).instances[0]?.payload
    expect(taskPayload).toEqual({
      directReplay: {
        version: 1,
        connections: 8,
        requestModifiers: ['headers', 'proxy', 'extraEngineOptions'],
        replayability: 'requires-credentials',
      },
    })
    const serializedPayload = JSON.stringify(taskPayload)
    for (const secret of Object.values(secrets)) {
      expect(serializedPayload).not.toContain(secret)
    }
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
    const deps = makeDeps()

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://original.example/file.zip'],
        saveDir: '/d',
        filename: 'file.zip',
        headers: [],
      },
      { ...deps, orchestrator }
    )

    const resultLog = logInfo.mock.calls.find(
      (call) => call[1] === 'beforeCreate hook chain result'
    )
    expect(resultLog?.[0]).toMatchObject({
      rewrittenUris: ['https://cdn.example/file.zip'],
      contributors: { uris: 'plugin-rewriter' },
    })
    const task = lastAddedTask(deps)
    expect(task.uris).toEqual([
      `https://cdn.example/file.zip?signature=${rewrittenSecret}`,
    ])
    expect(task.instances[0]?.uris).toEqual(task.uris)
    expect(task.instances[0]?.payload).toEqual({
      directReplay: {
        version: 1,
        requestModifiers: [],
        replayability: 'uri-only',
      },
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
    expect(lastAddedTask(deps).instances[0]?.payload).toEqual({
      directReplay: {
        version: 1,
        requestModifiers: [],
        replayability: 'uri-only',
      },
    })
  })

  it('persists a captured validator for a public direct download', async () => {
    const deps = makeDeps()
    const resourceValidator = {
      kind: 'strong-etag' as const,
      value: '"release-v1"',
      contentLength: 4096,
      capturedAt: 7,
    }
    const capture = vi.fn().mockResolvedValue(resourceValidator)
    deps.directResourceValidator = { capture }

    await handleCreateTask(httpRequest(), deps)

    expect(capture).toHaveBeenCalledWith('https://a/b', {})
    expect(lastAddedTask(deps).instances[0]?.payload).toEqual({
      directReplay: {
        version: 1,
        requestModifiers: [],
        replayability: 'uri-only',
        resourceValidator,
      },
    })
  })

  it('passes the effective engine User-Agent to metadata discovery', async () => {
    const deps = makeDeps({ engineUserAgent: 'Motrix/Test' })
    const probe = vi.fn(async () => {
      vi.spyOn(deps.settingsManager, 'getEngine').mockReturnValue({
        ...DEFAULT_ENGINE_SETTINGS,
        userAgent: 'Motrix/Newer',
      })
      return { filename: null, validator: null }
    })
    deps.directResourceValidator = { capture: vi.fn(), probe }

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/stable'],
        saveDir: '/d',
        headers: [],
      },
      deps
    )

    expect(probe).toHaveBeenCalledWith('https://example.com/stable', {
      userAgent: 'Motrix/Test',
    })
    expect(deps.addUri).toHaveBeenCalledWith(
      ['https://example.com/stable'],
      expect.objectContaining({ 'user-agent': 'Motrix/Test' })
    )
  })

  it('skips metadata when a concrete aria2 lacks mirrored header features', async () => {
    const deps = makeDeps({
      engineFeatureReport: {
        version: '1.37.0',
        features: ['GZip'],
        hasSqlitePersistence: false,
        hasBtSeedUnverified: false,
        hasBtSaveMetadata: false,
        hasMoveStorage: false,
      },
    })
    const probe = vi.fn()
    const capture = vi.fn()
    deps.directResourceValidator = { probe, capture }

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/stable'],
        saveDir: '/d',
        headers: [],
      },
      deps
    )

    expect(probe).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(deps.addUri).toHaveBeenCalledOnce()
  })

  it('preserves unsafe ambient aria2 behavior and records it as non-replayable', async () => {
    const deps = makeDeps()
    ;(deps.adapter as Aria2Adapter).setDirectResourceMetadataProfile(null)
    const probe = vi.fn()
    const capture = vi.fn()
    deps.directResourceValidator = { probe, capture }

    await handleCreateTask(httpRequest(), deps)

    expect(probe).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(lastAddedTask(deps).instances[0]?.payload).toEqual({
      directReplay: {
        version: 1,
        requestModifiers: ['engineGlobalOptions'],
        replayability: 'requires-credentials',
      },
    })
    const options = deps.addUri.mock.calls[0]?.[1]
    expect(options?.header).toEqual(['Accept: */*'])
    expect(options).not.toHaveProperty('no-netrc')
  })

  it('skips metadata when passthrough engine options change HTTP semantics', async () => {
    const deps = makeDeps()
    const probe = vi.fn()
    const capture = vi.fn()
    deps.directResourceValidator = { capture, probe }

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/stable'],
        saveDir: '/d',
        headers: [],
      },
      deps,
      { extraEngineOptions: { referer: 'https://origin.example/' } }
    )

    expect(probe).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(deps.addUri).toHaveBeenCalledOnce()
  })

  it('skips metadata when a task header cannot be represented by Fetch', async () => {
    const deps = makeDeps()
    const probe = vi.fn()
    const capture = vi.fn()
    deps.directResourceValidator = { capture, probe }

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/stable'],
        saveDir: '/d',
        headers: [{ name: 'Host', value: 'other.example' }],
      },
      deps
    )

    expect(probe).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(deps.addUri).toHaveBeenCalledOnce()
  })

  it('does not probe a direct request that depends on credentials', async () => {
    const deps = makeDeps()
    const capture = vi.fn()
    deps.directResourceValidator = { capture }

    await handleCreateTask(
      {
        ...httpRequest(),
        headers: [{ name: 'Authorization', value: 'Bearer secret' }],
      },
      deps
    )

    expect(capture).not.toHaveBeenCalled()
    expect(lastAddedTask(deps).instances[0]?.payload).toEqual({
      directReplay: {
        version: 1,
        requestModifiers: ['headers'],
        replayability: 'requires-credentials',
      },
    })
  })

  it('does not attach one validator to an ambiguous mirror set', async () => {
    const deps = makeDeps()
    const capture = vi.fn()
    deps.directResourceValidator = { capture }

    await handleCreateTask(
      {
        ...httpRequest(),
        uris: [
          'https://mirror-a.example/file',
          'https://mirror-b.example/file',
        ],
      },
      deps
    )

    expect(capture).not.toHaveBeenCalled()
    expect(
      lastAddedTask(deps).instances[0]?.payload.directReplay
    ).not.toHaveProperty('resourceValidator')
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
    expect(task.diskPath).toMatch(/^\/d\/\.motrix\/[a-f0-9]{20}$/)
    expect(task.instances[0].payload.btStorageLayout).toMatchObject({
      version: 1,
      strategy: 'indexed-staging',
      workspacePath: task.diskPath,
      payloadEntry: 'p',
      torrentRootName: 'ubuntu-25.10-desktop-amd64.iso',
      multiFile: false,
    })
    const [, , options] = deps.addTorrent.mock.calls[0]
    expect(options).toMatchObject({
      dir: task.diskPath,
      'index-out': ['1=p'],
    })
    expect(options).not.toHaveProperty('bt-prioritize-piece')
  })

  it('enables preview piece priority for a video-only torrent', async () => {
    const deps = makeDeps({ addTorrentGid: 'gid-bt' })
    const bytes = buildMinimalTorrentBytes('Movie.MP4', false)

    await handleCreateTask(
      {
        type: 'bt',
        payload: {
          kind: 'torrent-base64',
          base64: Buffer.from(bytes).toString('base64'),
        },
        selectedFiles: [0],
        saveDir: '/d',
      },
      deps
    )

    const [, , options] = deps.addTorrent.mock.calls[0]
    expect(options['bt-prioritize-piece']).toBe('head=10M,tail=10M')
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
    const [, , options] = deps.addTorrent.mock.calls[0]
    expect(options).not.toHaveProperty('bt-prioritize-piece')
  })

  it('rejects a parseable torrent with an unsafe root path', async () => {
    const deps = makeDeps({ addTorrentGid: 'gid-bt' })
    const bytes = buildMinimalTorrentBytes('..', false)

    await expect(
      handleCreateTask(
        {
          type: 'bt',
          payload: {
            kind: 'torrent-base64',
            base64: Buffer.from(bytes).toString('base64'),
          },
          selectedFiles: [0],
          saveDir: '/d',
        },
        deps
      )
    ).rejects.toMatchObject({ code: ErrorCode.TorrentParseFailed })
    expect(deps.addTorrent).not.toHaveBeenCalled()
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
    const [, options] = deps.addUri.mock.calls[0]
    expect(options).not.toHaveProperty('bt-prioritize-piece')
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

  it('HTTP task: resolves a stable URL from final request params and prefers its explicit proxy', async () => {
    const deps = makeDeps({
      proxySettings: {
        ...DEFAULT_PROXY_SETTINGS,
        enabled: true,
        host: 'global-proxy.example',
        port: 3128,
        bypass: ['localhost'],
        scopes: { ...DEFAULT_PROXY_SETTINGS.scopes, download: true },
      },
    })
    const probe = vi.fn().mockResolvedValue({
      filename: '../../VSCodeUserSetup-x64-1.103.2.exe',
      validator: null,
    })
    const capture = vi.fn().mockResolvedValue(null)
    deps.directResourceValidator = { capture, probe }

    await handleCreateTask(
      {
        type: 'http',
        uris: [
          'https://update.code.visualstudio.com/latest/win32-x64-user/stable',
        ],
        saveDir: '/d',
        headers: [{ name: 'User-Agent', value: 'Motrix test' }],
        proxy: 'http://proxy.example:8080',
      },
      deps
    )

    expect(probe).toHaveBeenCalledWith(
      'https://update.code.visualstudio.com/latest/win32-x64-user/stable',
      {
        headers: { 'User-Agent': 'Motrix test' },
        proxy: 'http://proxy.example:8080',
        noProxy: 'localhost',
      }
    )
    expect(deps.pick).toHaveBeenCalledWith(
      '/d',
      'VSCodeUserSetup-x64-1.103.2.exe'
    )
    expect(deps.addUri).toHaveBeenCalledWith(
      ['https://update.code.visualstudio.com/latest/win32-x64-user/stable'],
      expect.objectContaining({
        dir: '/d',
        out: 'VSCodeUserSetup-x64-1.103.2.exe.motrix',
      })
    )
    expect(lastAddedTask(deps).finalName).toBe(
      'VSCodeUserSetup-x64-1.103.2.exe'
    )
    expect(capture).not.toHaveBeenCalled()
  })

  it('HTTP task: rejects an explicit SOCKS proxy before metadata or durable intent', async () => {
    const deps = makeDeps()
    const probe = vi.fn()
    const capture = vi.fn()
    deps.directResourceValidator = { capture, probe }

    await expect(
      handleCreateTask(
        {
          type: 'http',
          uris: ['https://downloads.example/stable'],
          saveDir: '/d',
          headers: [{ name: 'Authorization', value: 'Bearer secret' }],
          proxy: 'socks5://proxy.example:1080',
        },
        deps
      )
    ).rejects.toThrow('Task proxy must use aria2-compatible HTTP or HTTPS')

    expect(probe).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(deps.addUri).not.toHaveBeenCalled()
    expect(deps.reserveEngineTaskId).not.toHaveBeenCalled()
  })

  it('HTTP task: downloads through legacy IPv4 proxy syntax without metadata I/O', async () => {
    const deps = makeDeps()
    const probe = vi.fn()
    const capture = vi.fn()
    deps.directResourceValidator = { capture, probe }

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://downloads.example/stable'],
        saveDir: '/d',
        headers: [],
        proxy: 'http://user:pass@127.1:8080',
      },
      deps
    )

    expect(probe).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(deps.addUri).toHaveBeenCalledWith(
      ['https://downloads.example/stable'],
      expect.objectContaining({
        'all-proxy': 'http://127.1:8080',
        'all-proxy-user': 'user',
        'all-proxy-passwd': 'pass',
      })
    )
  })

  it('HTTP task: never probes through malformed task proxy syntax', async () => {
    const deps = makeDeps()
    const probe = vi.fn()
    const capture = vi.fn()
    deps.directResourceValidator = { capture, probe }

    await expect(
      handleCreateTask(
        {
          type: 'http',
          uris: ['https://downloads.example/stable'],
          saveDir: '/d',
          headers: [{ name: 'Authorization', value: 'Bearer secret' }],
          proxy: 'http://proxy.example:8080/not-an-authority',
        },
        deps
      )
    ).rejects.toThrow('Task proxy must use aria2-compatible HTTP or HTTPS')

    expect(probe).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(deps.addUri).not.toHaveBeenCalled()
    expect(deps.reserveEngineTaskId).not.toHaveBeenCalled()
  })

  it('HTTP task: rejects control characters decoded from proxy credentials before metadata or durable intent', async () => {
    const deps = makeDeps()
    const probe = vi.fn()
    const capture = vi.fn()
    deps.directResourceValidator = { capture, probe }

    await expect(
      handleCreateTask(
        {
          type: 'http',
          uris: ['https://downloads.example/stable'],
          saveDir: '/d',
          headers: [],
          proxy:
            'http://user%0Ahttp-proxy%3Dhttp%3A%2F%2Fevil:pass@proxy.example:8080',
        },
        deps
      )
    ).rejects.toThrow('Task proxy must use aria2-compatible HTTP or HTTPS')

    expect(probe).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(deps.addUri).not.toHaveBeenCalled()
    expect(deps.reserveEngineTaskId).not.toHaveBeenCalled()
  })

  it('HTTP task: skips metadata when the applied route is unavailable even with an explicit proxy', async () => {
    const deps = makeDeps({ appliedProxySnapshot: null })
    const probe = vi.fn()
    const capture = vi.fn()
    deps.directResourceValidator = { capture, probe }

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://downloads.example/stable'],
        saveDir: '/d',
        headers: [{ name: 'Authorization', value: 'Bearer secret' }],
        proxy: 'http://task-proxy.example:8080',
      },
      deps
    )

    expect(probe).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(deps.addUri).toHaveBeenCalledOnce()
  })

  it('HTTP task: uses the applied snapshot instead of newer settings for metadata', async () => {
    const deps = makeDeps({
      proxySettings: {
        ...DEFAULT_PROXY_SETTINGS,
        enabled: true,
        host: 'new-unapplied.example',
        port: 9000,
        scopes: { ...DEFAULT_PROXY_SETTINGS.scopes, download: true },
      },
      appliedProxySnapshot: {
        proxy: 'http://old-applied.example:8080',
        noProxy: '.internal',
      },
    })
    const capture = vi.fn().mockResolvedValue(null)
    deps.directResourceValidator = { capture }

    await handleCreateTask(httpRequest(), deps)

    expect(capture).toHaveBeenCalledWith('https://a/b', {
      proxy: 'http://old-applied.example:8080',
      noProxy: '.internal',
    })
  })

  it('HTTP task: aborts before addUri when restart invalidates its metadata lease', async () => {
    const deps = makeDeps()
    let finishCapture: (() => void) | undefined
    const captureGate = new Promise<void>((resolve) => {
      finishCapture = resolve
    })
    const capture = vi.fn(async () => {
      await captureGate
      return null
    })
    deps.directResourceValidator = { capture }
    deps.assertEngineReady = vi.fn()

    const creating = handleCreateTask(httpRequest(), deps)
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
    ;(
      deps.directResourceProxyPolicy as AppliedDownloadProxyPolicy
    ).markUnavailable()
    finishCapture?.()

    await expect(creating).rejects.toThrow(
      'applied download proxy policy changed'
    )
    expect(deps.addUri).not.toHaveBeenCalled()
  })

  it('HTTP task: an explicit filename skips discovery but still captures a URI-only validator once', async () => {
    const deps = makeDeps({
      proxySettings: {
        ...DEFAULT_PROXY_SETTINGS,
        enabled: true,
        host: 'proxy.example',
        port: 8080,
        bypass: ['localhost'],
        scopes: { ...DEFAULT_PROXY_SETTINGS.scopes, download: true },
      },
    })
    const probe = vi.fn()
    const capture = vi.fn().mockResolvedValue({
      kind: 'strong-etag' as const,
      value: '"proxied-release"',
      capturedAt: 9,
    })
    deps.directResourceValidator = {
      capture,
      probe,
    }

    await handleCreateTask(
      {
        type: 'http',
        uris: [
          'https://update.code.visualstudio.com/latest/win32-x64-user/stable',
        ],
        saveDir: '/d',
        filename: 'chosen.exe',
        headers: [],
      },
      deps
    )

    expect(probe).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledWith(
      'https://update.code.visualstudio.com/latest/win32-x64-user/stable',
      {
        proxy: 'http://proxy.example:8080',
        noProxy: 'localhost',
      }
    )
    expect(deps.pick).toHaveBeenCalledWith('/d', 'chosen.exe')
    expect(lastAddedTask(deps).instances[0]?.payload).toEqual({
      directReplay: {
        version: 1,
        requestModifiers: [],
        replayability: 'uri-only',
        resourceValidator: {
          kind: 'strong-etag',
          value: '"proxied-release"',
          capturedAt: 9,
        },
      },
    })
  })

  it.each([
    ['download.php', 'release.zip'],
    ['api/file.bin', 'real-installer.exe'],
  ])(
    'HTTP task: probes a single URI ending in %s despite its apparent extension',
    async (uriPath, remoteName) => {
      const deps = makeDeps()
      const probe = vi.fn().mockResolvedValue({
        filename: remoteName,
        validator: null,
      })
      deps.directResourceValidator = {
        capture: vi.fn(),
        probe,
      }

      await handleCreateTask(
        {
          type: 'http',
          uris: [`https://example.com/${uriPath}`],
          saveDir: '/d',
          headers: [],
        },
        deps
      )

      expect(probe).toHaveBeenCalledOnce()
      expect(deps.pick).toHaveBeenLastCalledWith('/d', remoteName)
      expect(lastAddedTask(deps).finalName).toBe(remoteName)
    }
  )

  it.each([
    ['ASCII', `${'release'.repeat(80)}.zip`],
    ['Chinese', `${'下载文件'.repeat(80)}.zip`],
    ['emoji', `${'📦🚀'.repeat(80)}.zip`],
  ])(
    'HTTP task: keeps a deduplicated long %s filename within the filesystem byte limit',
    async (_label, remoteName) => {
      const safeRemoteName = sanitizeRemoteFilename(remoteName) as string
      const picker = new FinalNamePickerImpl({
        exists: vi.fn(
          async (candidate) => candidate === `/d/${safeRemoteName}`
        ),
      })
      const deps = makeDeps({
        pick: (dir, name) => picker.pick(dir, name),
      })
      deps.directResourceValidator = {
        capture: vi.fn(),
        probe: vi.fn().mockResolvedValue({
          filename: remoteName,
          validator: null,
        }),
      }

      await handleCreateTask(
        {
          type: 'http',
          uris: ['https://example.com/stable'],
          saveDir: '/d',
          headers: [],
        },
        deps
      )

      const task = lastAddedTask(deps)
      expect(task.finalName).toMatch(/ \(1\)\.zip$/)
      expect(
        Buffer.byteLength(`${task.finalName}.motrix`, 'utf8')
      ).toBeLessThanOrEqual(255)
      expect(Buffer.from(task.finalName, 'utf8').toString('utf8')).toBe(
        task.finalName
      )
    }
  )

  it('HTTP task: reuses the filename probe validator without a second HEAD', async () => {
    const deps = makeDeps()
    const resourceValidator = {
      kind: 'strong-etag' as const,
      value: '"release-v1"',
      contentLength: 4096,
      capturedAt: 7,
    }
    const probe = vi.fn().mockResolvedValue({
      filename: 'release.zip',
      validator: resourceValidator,
    })
    const capture = vi.fn()
    deps.directResourceValidator = { capture, probe }

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/stable'],
        saveDir: '/d',
        headers: [],
      },
      deps
    )

    expect(probe).toHaveBeenCalledOnce()
    expect(capture).not.toHaveBeenCalled()
    expect(lastAddedTask(deps).instances[0]?.payload).toEqual({
      directReplay: {
        version: 1,
        requestModifiers: [],
        replayability: 'uri-only',
        resourceValidator,
      },
    })
  })

  it('HTTP task: persists a validator observed through the global download proxy without proxy credentials', async () => {
    const deps = makeDeps({
      proxySettings: {
        ...DEFAULT_PROXY_SETTINGS,
        enabled: true,
        host: 'proxy.example',
        port: 8080,
        user: 'proxy-user',
        password: 'proxy-pass',
        bypass: ['localhost', '*.internal'],
        scopes: { ...DEFAULT_PROXY_SETTINGS.scopes, download: true },
      },
    })
    const probe = vi.fn().mockResolvedValue({
      filename: 'release.zip',
      validator: {
        kind: 'strong-etag' as const,
        value: '"proxied-release"',
        capturedAt: 8,
      },
    })
    const capture = vi.fn()
    deps.directResourceValidator = { capture, probe }

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/download.php'],
        saveDir: '/d',
        headers: [],
      },
      deps
    )

    expect(probe).toHaveBeenCalledWith('https://example.com/download.php', {
      proxy: 'http://proxy-user:proxy-pass@proxy.example:8080',
      noProxy: 'localhost,*.internal',
    })
    expect(capture).not.toHaveBeenCalled()
    const payload = lastAddedTask(deps).instances[0]?.payload
    expect(payload).toEqual({
      directReplay: {
        version: 1,
        requestModifiers: [],
        replayability: 'uri-only',
        resourceValidator: {
          kind: 'strong-etag',
          value: '"proxied-release"',
          capturedAt: 8,
        },
      },
    })
    expect(JSON.stringify(payload)).not.toContain('proxy-user')
    expect(JSON.stringify(payload)).not.toContain('proxy-pass')
    expect(JSON.stringify(payload)).not.toContain('proxy.example')
  })

  it('HTTP task: metadata failure logs no signed URL or credential value', async () => {
    const deps = makeDeps()
    deps.directResourceValidator = {
      capture: vi.fn(),
      probe: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'https://example.com/stable?token=URL_SECRET Authorization=AUTH_SECRET'
          )
        ),
    }

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/stable?token=URL_SECRET'],
        saveDir: '/d',
        headers: [{ name: 'Authorization', value: 'Bearer AUTH_SECRET' }],
      },
      deps
    )

    const serializedLogs = JSON.stringify({
      debug: logDebug.mock.calls,
      info: logInfo.mock.calls,
      warn: logWarn.mock.calls,
      error: logError.mock.calls,
    })
    expect(serializedLogs).not.toContain('URL_SECRET')
    expect(serializedLogs).not.toContain('AUTH_SECRET')
    expect(serializedLogs).toContain('example.com')
    expect(lastAddedTask(deps).finalName).toBe('stable')
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
    expect(lastAddedTask(deps).instances[0]?.payload).toEqual({
      directReplay: {
        version: 1,
        connections: 1,
        requestModifiers: ['extraEngineOptions'],
        replayability: 'requires-credentials',
      },
    })
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

  it('waits for mux fallback and a successful hook rewrite before probing metadata', async () => {
    const order: string[] = []
    const chainResult = makeChainCommit({
      uris: ['https://cdn.example/api/file.bin'],
      headers: [{ name: 'User-Agent', value: 'plugin-agent' }],
      proxy: 'http://plugin-proxy.example:8080',
      headerContributors: ['plugin-a'],
      uriContributor: 'plugin-a',
      proxyContributor: 'plugin-a',
    })
    const orchestrator = {
      runBeforeCreateHttp: vi.fn(async () => {
        order.push('hook')
        return chainResult
      }),
      runBeforeFinalize: vi.fn(),
      runParallel: vi.fn(),
    } as unknown as Deps['orchestrator']
    const resolveToMux = vi.fn(async () => {
      order.push('mux')
      return null
    })
    const dispatchMux = vi.fn()
    const probe = vi.fn(async () => {
      order.push('probe')
      return { filename: 'rewritten.exe', validator: null }
    })
    const deps = makeDeps()

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://origin.example/stable'],
        saveDir: '/d',
        headers: [],
      },
      {
        ...deps,
        orchestrator,
        resolveToMux,
        dispatchMux,
        directResourceValidator: { capture: vi.fn(), probe },
      }
    )

    expect(order).toEqual(['mux', 'hook', 'probe'])
    expect(probe).toHaveBeenCalledWith('https://cdn.example/api/file.bin', {
      headers: { 'User-Agent': 'plugin-agent' },
      proxy: 'http://plugin-proxy.example:8080',
    })
    expect(deps.addUri.mock.calls[0]?.[0]).toEqual([
      'https://cdn.example/api/file.bin',
    ])
  })

  it('keeps the rewritten URI basename when its metadata probe fails', async () => {
    const orchestrator = makeOrchestrator(
      makeChainCommit({
        uris: ['https://cdn.example/release.zip'],
        uriContributor: 'plugin-a',
      })
    )
    const probe = vi.fn().mockRejectedValue(new Error('metadata unavailable'))
    const capture = vi.fn()
    const deps = makeDeps()

    await handleCreateTask(
      {
        type: 'http',
        uris: ['https://origin.example/stable'],
        saveDir: '/d',
        headers: [],
      },
      {
        ...deps,
        orchestrator,
        directResourceValidator: { capture, probe },
      }
    )

    expect(probe).toHaveBeenCalledWith('https://cdn.example/release.zip', {})
    expect(capture).not.toHaveBeenCalled()
    expect(deps.pick).toHaveBeenLastCalledWith('/d', 'release.zip')
    expect(deps.addUri).toHaveBeenCalledWith(
      ['https://cdn.example/release.zip'],
      expect.objectContaining({ out: 'release.zip.motrix' })
    )
    expect(lastAddedTask(deps)).toMatchObject({
      finalName: 'release.zip',
      finalPath: '/d/release.zip',
      diskPath: '/d/release.zip.motrix',
    })
  })

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
    const probe = vi.fn().mockResolvedValue({
      filename: 'rewritten-release.exe',
      validator: null,
    })
    const fullDeps = {
      ...deps,
      orchestrator,
      auditLog,
      directResourceValidator: { capture: vi.fn(), probe },
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
    expect(options.header).toEqual([
      'X-Plugin: on',
      'User-Agent: rewritten',
      'Cookie: ',
      'Authorization: ',
      'Accept: */*',
    ])
    expect(options['all-proxy']).toBe('http://proxy.example:1080')
    expect(options.out).toBe('rewritten-release.exe.motrix')
    expect(probe).toHaveBeenCalledWith('https://cdn.example/b', {
      headers: { 'X-Plugin': 'on', 'User-Agent': 'rewritten' },
      proxy: 'http://proxy.example:1080',
    })
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

  it('rejects a plugin-rewritten SOCKS proxy before metadata or durable intent', async () => {
    const orchestrator = makeOrchestrator(
      makeChainCommit({
        proxy: 'socks5://proxy.example:1080',
        proxyContributor: 'plugin-a',
      })
    )
    const deps = makeDeps()
    const probe = vi.fn()
    const capture = vi.fn()

    await expect(
      handleCreateTask(httpRequest(), {
        ...deps,
        orchestrator,
        directResourceValidator: { capture, probe },
      })
    ).rejects.toThrow('Task proxy must use aria2-compatible HTTP or HTTPS')

    expect(probe).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(deps.addUri).not.toHaveBeenCalled()
    expect(deps.reserveEngineTaskId).not.toHaveBeenCalled()
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
    const probe = vi.fn()
    const capture = vi.fn()
    const fullDeps = {
      ...deps,
      orchestrator,
      auditLog,
      directResourceValidator: { capture, probe },
    }

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
    expect(probe).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
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

  it('waits for HTTP readiness before acquiring the applied-proxy lease', async () => {
    const order: string[] = []
    const deps = makeDeps({
      waitForEngineReady: async () => {
        order.push('gate')
      },
    })
    const policy = deps.directResourceProxyPolicy
    deps.directResourceProxyPolicy = {
      snapshot: () => policy.snapshot(),
      runWithSnapshot: (operation) => {
        order.push('reader')
        return policy.runWithSnapshot(operation)
      },
    }
    deps.addUri.mockImplementation(async (_uris, options) => {
      order.push('adapter')
      return String(options.gid)
    })

    await handleCreateTask(httpRequest(), deps)

    expect(order).toEqual(['gate', 'reader', 'adapter'])
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
    const probe = vi.fn()
    const capture = vi.fn()
    const result = await handleCreateTask(
      {
        type: 'http',
        uris: ['https://www.youtube.com/watch?v=abc'],
        saveDir: '/d',
        headers: [],
      },
      {
        ...deps,
        resolveToMux,
        dispatchMux,
        directResourceValidator: { capture, probe },
      }
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
    expect(probe).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
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
    let muxFinished = false
    const resolveToMux = vi.fn(async () => {
      muxFinished = true
      return null
    })
    const dispatchMux = vi.fn()
    const deps = makeDeps({ addUriGid: 'gid-http' })
    const probe = vi.fn(async () => {
      expect(muxFinished).toBe(true)
      return { filename: 'release.zip', validator: null }
    })
    const result = await handleCreateTask(
      {
        type: 'http',
        uris: ['https://example.com/file.zip'],
        saveDir: '/d',
        headers: [],
      },
      {
        ...deps,
        resolveToMux,
        dispatchMux,
        directResourceValidator: { capture: vi.fn(), probe },
      }
    )
    expect(deps.addUri).toHaveBeenCalledOnce()
    expect(dispatchMux).not.toHaveBeenCalled()
    expect(probe).toHaveBeenCalledOnce()
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
