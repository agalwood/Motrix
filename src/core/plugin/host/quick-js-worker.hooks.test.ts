import path from 'node:path'
import type { HookInvocationScopeV1 } from '@shared/schemas/plugin-hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityHost } from '../capabilities/interface'
import { StagedEffectStore } from '../hooks/staged-effects'
import type { CapabilityBridge } from './capability-bridge'
import { makeStubCapabilityHost, spawnTestBridge } from './test-helpers'

const FIXTURE_ROOT = path.resolve(
  __dirname,
  '../../../../tests/fixtures/plugins'
)
const FS_TASK_HOST = {} as ReturnType<CapabilityHost['fsTaskFor']>

const TASK = {
  schemaVersion: 1,
  id: 'task-1',
  name: 'archive.zip',
  type: 'http',
  kind: 'direct',
  status: 'completed',
  filePath: '/downloads/archive.zip',
  saveDir: '/downloads',
  filename: 'archive.zip',
  progress: 100,
  totalBytes: 10,
  downloadedBytes: 10,
  uploadedBytes: 0,
  sizeWhenDone: 10,
  fileCount: 1,
  createdAt: 1,
  updatedAt: 2,
  finishedAt: 3,
  category: null,
  infoHash: null,
  error: null,
} as const

const BT_TASK = {
  ...TASK,
  id: 'task-bt',
  name: 'archive.torrent',
  type: 'bt',
  kind: 'bt',
  filename: 'archive.torrent',
  infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
} as const

const liveBridges: CapabilityBridge[] = []

afterEach(async () => {
  await Promise.all(liveBridges.splice(0).map((bridge) => bridge.dispose()))
})

function scope(id: string): HookInvocationScopeV1 {
  return {
    invocationId: id,
    callChainId: `chain-${id}`,
    permissionGeneration: 1,
  }
}

function beforeCreatePayload(filename = 'archive.zip') {
  return {
    sourceUrl: 'https://example.test/archive.zip',
    createdBy: 'user',
    requestedAt: 1,
    type: 'http',
    uris: ['https://example.test/archive.zip'],
    saveDir: '/downloads',
    filename,
    headers: [],
  }
}

async function spawn(fixture: string, capabilityHost?: CapabilityHost) {
  const spawned = await spawnTestBridge(path.join(FIXTURE_ROOT, fixture), {
    timeoutMs: 15_000,
    capabilityHost,
  })
  liveBridges.push(spawned.bridge)
  return spawned
}

describe('QuickJS Worker Hook contract', () => {
  it('reports timeout fire and interval clear timer activity transitions', async () => {
    const activity: number[] = []
    const spawned = await spawnTestBridge(
      path.join(FIXTURE_ROOT, 'test.timer-activity'),
      {
        beforeReady: (bridge) => {
          bridge.getWorker().on('message', (message: unknown) => {
            const candidate = message as {
              type?: unknown
              activeCount?: unknown
            }
            if (
              candidate.type === 'timer_activity' &&
              typeof candidate.activeCount === 'number'
            ) {
              activity.push(candidate.activeCount)
            }
          })
        },
      }
    )
    liveBridges.push(spawned.bridge)

    await spawned.callPlugin('test.timer-activity.timeout', { delay: 20 })
    await vi.waitFor(() => expect(activity).toEqual([1, 0]))

    activity.length = 0
    await spawned.callPlugin('test.timer-activity.interval', { delay: 10 })
    await vi.waitFor(() => expect(activity).toEqual([1]))
    await spawned.callPlugin('test.timer-activity.clear', {})
    await vi.waitFor(() => expect(activity).toEqual([1, 0]))
  })

  it('executes the SDK 2.0 four-Hook surface with synchronous metadata', async () => {
    const spawned = await spawn('test.hook-sdk-2-0')
    const stagedCreate = new StagedEffectStore()
    spawned.bridge.setHookContext({
      fsTaskHost: FS_TASK_HOST,
      taskId: TASK.id,
      phase: 'beforeCreate',
      staged: stagedCreate,
      role: 'enrich',
      saveDir: TASK.saveDir,
      pluginStorageRoot: '/plugins/test.hook-sdk-2-0',
    })
    const createEffects = await spawned.bridge.callHook(
      'beforeCreate',
      TASK.id,
      new AbortController().signal,
      5_000,
      beforeCreatePayload(),
      { seed: 'original' },
      scope('create')
    )

    expect(createEffects).toEqual({
      schemaVersion: 1,
      contextPatches: [{ filename: 'original-1' }],
      metadataOperations: [
        { op: 'set', key: 'sdk20', value: { count: 1 } },
        { op: 'delete', key: 'seed' },
      ],
    })
    expect(stagedCreate.latestStagedFields()).toEqual({
      filename: 'original-1',
    })

    const stagedFinalize = new StagedEffectStore()
    spawned.bridge.setHookContext({
      fsTaskHost: FS_TASK_HOST,
      taskId: TASK.id,
      phase: 'beforeFinalize',
      staged: stagedFinalize,
      role: 'post-process',
      saveDir: TASK.saveDir,
      pluginStorageRoot: '/plugins/test.hook-sdk-2-0',
    })
    await spawned.bridge.callHook(
      'beforeFinalize',
      TASK.id,
      new AbortController().signal,
      5_000,
      {
        sourceUrl: 'https://example.test/archive.zip',
        createdBy: 'user',
        requestedAt: 1,
        task: TASK,
        inputFilePath: TASK.filePath,
        filePath: TASK.filePath,
        targetFilePath: TASK.filePath,
      },
      { release: 'stable' },
      scope('finalize')
    )
    expect(stagedFinalize.pendingFinalizePath).toBe(
      '/downloads/archive.zip.sdk20'
    )

    const delivery = {
      schemaVersion: 1,
      id: 'delivery-1',
      occurrenceId: 'occurrence-1',
      occurredAt: 3,
    }
    spawned.bridge.setHookContext({ fsTaskHost: FS_TASK_HOST, taskId: TASK.id })
    await spawned.bridge.callHook(
      'afterComplete',
      TASK.id,
      new AbortController().signal,
      5_000,
      { task: TASK, filePath: TASK.filePath, delivery },
      { release: 'stable' },
      scope('complete')
    )

    spawned.bridge.setHookContext({ fsTaskHost: FS_TASK_HOST, taskId: TASK.id })
    await spawned.bridge.callHook(
      'onError',
      TASK.id,
      new AbortController().signal,
      5_000,
      {
        task: { ...TASK, status: 'error' },
        filePath: TASK.filePath,
        delivery: { ...delivery, id: 'delivery-2' },
        error: {
          code: 'download.failed',
          message: 'failed',
          detailKey: null,
          detailParams: null,
        },
      },
      { release: 'stable' },
      scope('error')
    )

    expect(
      await spawned.callPlugin('test.hook-sdk-2-0.read', undefined)
    ).toEqual([
      {
        hook: 'beforeCreate',
        hasAfterSet: true,
        keys: ['sdk20'],
        aborted: false,
      },
      {
        hook: 'beforeFinalize',
        sourceUrl: 'https://example.test/archive.zip',
        taskId: TASK.id,
        saveDir: TASK.saveDir,
        metadata: { release: 'stable' },
      },
      {
        hook: 'afterComplete',
        taskId: TASK.id,
        filePath: TASK.filePath,
        keys: ['release'],
      },
      {
        hook: 'onError',
        taskId: TASK.id,
        errorCode: 'download.failed',
        metadata: { release: 'stable' },
      },
    ])
  }, 20_000)

  it('normalizes BT beforeFinalize sourceUrl to a non-secret canonical identifier', async () => {
    const spawned = await spawn('test.hook-sdk-2-0')
    const staged = new StagedEffectStore()
    spawned.bridge.setHookContext({
      fsTaskHost: FS_TASK_HOST,
      taskId: BT_TASK.id,
      phase: 'beforeFinalize',
      staged,
      role: 'post-process',
      saveDir: BT_TASK.saveDir,
      pluginStorageRoot: '/plugins/test.hook-sdk-2-0',
    })

    await spawned.bridge.callHook(
      'beforeFinalize',
      BT_TASK.id,
      new AbortController().signal,
      5_000,
      {
        // A torrent path or empty legacy value must never reach the guest.
        sourceUrl: '',
        createdBy: 'user',
        requestedAt: 1,
        task: BT_TASK,
        inputFilePath: BT_TASK.filePath,
        filePath: BT_TASK.filePath,
        targetFilePath: BT_TASK.filePath,
      },
      {},
      scope('bt-finalize')
    )

    expect(
      await spawned.callPlugin('test.hook-sdk-2-0.read', undefined)
    ).toEqual([
      {
        hook: 'beforeFinalize',
        sourceUrl: `urn:btih:${BT_TASK.infoHash.toLowerCase()}`,
        taskId: BT_TASK.id,
        saveDir: BT_TASK.saveDir,
        metadata: {},
      },
    ])
  }, 20_000)

  it('exposes readonly post metadata and the stable delivery envelope', async () => {
    const spawned = await spawn('test.hook-delivery-runtime')
    const delivery = {
      schemaVersion: 1,
      id: 'delivery-runtime-1',
      occurrenceId: 'occurrence-runtime-1',
      occurredAt: 42,
    }
    spawned.bridge.setHookContext({ fsTaskHost: FS_TASK_HOST, taskId: TASK.id })
    const effects = await spawned.bridge.callHook(
      'afterComplete',
      TASK.id,
      new AbortController().signal,
      5_000,
      { task: TASK, filePath: TASK.filePath, delivery },
      {},
      scope('delivery')
    )
    expect(effects).toEqual({
      schemaVersion: 1,
      contextPatches: [],
      metadataOperations: [],
    })
    expect(
      await spawned.callPlugin('test.hook-delivery-runtime.read', undefined)
    ).toEqual([
      {
        hook: 'afterComplete',
        deliveryId: delivery.id,
        occurrenceId: delivery.occurrenceId,
        occurredAt: delivery.occurredAt,
        metadataReadonly: true,
      },
    ])
  }, 20_000)

  it('delivers one AbortSignal event before rejecting the Hook', async () => {
    const spawned = await spawn('test.hook-sdk-2-0')
    const staged = new StagedEffectStore()
    const controller = new AbortController()
    spawned.bridge.setHookContext({
      fsTaskHost: FS_TASK_HOST,
      taskId: TASK.id,
      phase: 'beforeCreate',
      staged,
      role: 'enrich',
      saveDir: TASK.saveDir,
      pluginStorageRoot: '/plugins/test.hook-sdk-2-0',
    })
    const result = spawned.bridge.callHook(
      'beforeCreate',
      TASK.id,
      controller.signal,
      5_000,
      beforeCreatePayload('abort'),
      {},
      scope('abort')
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    controller.abort('test abort')
    await expect(result).rejects.toMatchObject({ code: 'plugin.hook.aborted' })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    expect(
      await spawned.callPlugin('test.hook-sdk-2-0.read', undefined)
    ).toEqual([
      { hook: 'onabort', aborted: true, reason: 'plugin hook aborted' },
      { hook: 'abort-listener' },
    ])
  }, 20_000)

  it('keeps a retained timer bound to its completed invocation', async () => {
    const spawned = await spawn('test.hook-sdk-2-0')
    spawned.bridge.setHookContext({
      fsTaskHost: FS_TASK_HOST,
      taskId: TASK.id,
      phase: 'beforeCreate',
      staged: new StagedEffectStore(),
      role: 'enrich',
      saveDir: TASK.saveDir,
      pluginStorageRoot: '/plugins/test.hook-sdk-2-0',
    })
    await spawned.bridge.callHook(
      'beforeCreate',
      TASK.id,
      new AbortController().signal,
      5_000,
      beforeCreatePayload('late'),
      {},
      scope('late')
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 30))

    expect(
      await spawned.callPlugin('test.hook-sdk-2-0.read', undefined)
    ).toEqual([
      {
        hook: 'late-capability',
        code: 'plugin.hook.concurrent_protocol_violation',
      },
    ])
  }, 20_000)

  it('keeps a pending Host promise bound to Hook A while Hook B is active', async () => {
    let releaseGet!: () => void
    const capabilityHost = makeStubCapabilityHost()
    const set = vi.fn(async () => ({ version: 1 }))
    Object.assign(capabilityHost, {
      storage: {
        get: vi.fn(
          async () =>
            new Promise<{ value: undefined; version: number }>((resolve) => {
              releaseGet = () => resolve({ value: undefined, version: 0 })
            })
        ),
        set,
      } as unknown as CapabilityHost['storage'],
    })
    const spawned = await spawn('test.hook-sdk-2-0', capabilityHost)

    spawned.bridge.setHookContext({
      fsTaskHost: FS_TASK_HOST,
      taskId: TASK.id,
      phase: 'beforeCreate',
      staged: new StagedEffectStore(),
      role: 'enrich',
      saveDir: TASK.saveDir,
      pluginStorageRoot: '/plugins/test.hook-sdk-2-0',
    })
    await spawned.bridge.callHook(
      'beforeCreate',
      TASK.id,
      new AbortController().signal,
      5_000,
      beforeCreatePayload('late-promise'),
      {},
      scope('promise-a')
    )
    expect(spawned.bridge.operationState()).toMatchObject({
      capabilityCalls: 1,
      ffmpegOperations: 0,
    })

    const controller = new AbortController()
    spawned.bridge.setHookContext({
      fsTaskHost: FS_TASK_HOST,
      taskId: TASK.id,
      phase: 'beforeCreate',
      staged: new StagedEffectStore(),
      role: 'enrich',
      saveDir: TASK.saveDir,
      pluginStorageRoot: '/plugins/test.hook-sdk-2-0',
    })
    const hookB = spawned.bridge.callHook(
      'beforeCreate',
      TASK.id,
      controller.signal,
      5_000,
      beforeCreatePayload('abort'),
      {},
      scope('promise-b')
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    releaseGet()
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    expect(set).not.toHaveBeenCalled()

    controller.abort()
    await expect(hookB).rejects.toMatchObject({ code: 'plugin.hook.aborted' })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(
      await spawned.callPlugin('test.hook-sdk-2-0.read', undefined)
    ).toEqual([
      {
        hook: 'late-promise',
        code: 'plugin.hook.concurrent_protocol_violation',
      },
      { hook: 'onabort', aborted: true, reason: 'plugin hook aborted' },
      { hook: 'abort-listener' },
    ])
  }, 20_000)

  it('rejects a plugin self-command before local dispatch or Host enqueue', async () => {
    const spawned = await spawn('test.hook-sdk-2-0')
    await expect(
      spawned.callPlugin('test.hook-sdk-2-0.self-call', undefined)
    ).resolves.toEqual({ code: 'plugin.runtime.reentrant_call' })
  }, 20_000)

  it('provides safe WHATWG URL and URLSearchParams globals', async () => {
    const spawned = await spawn('test.hook-sdk-2-0')
    await expect(
      spawned.callPlugin('test.hook-sdk-2-0.url', undefined)
    ).resolves.toEqual({
      href: 'https://user:pass@example.test:8443/a/archive.zip?part=1&part=2#download',
      protocol: 'https:',
      origin: 'https://example.test:8443',
      host: 'example.test:8443',
      hostname: 'example.test',
      port: '8443',
      pathname: '/a/archive.zip',
      search: '?part=1&part=2',
      hash: '#download',
      username: 'user',
      password: 'pass',
      string:
        'https://user:pass@example.test:8443/a/archive.zip?part=1&part=2#download',
      json: 'https://user:pass@example.test:8443/a/archive.zip?part=1&part=2#download',
      part: ['1', '2'],
      params: 'a=1&a=2&b=hello+world',
      paramsAll: ['1', '2'],
    })
  }, 20_000)
})
