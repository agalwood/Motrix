import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ActivationDispatcher } from '@core/plugin/host/activation-dispatcher'
import { makeStubCapabilityHost } from '@core/plugin/host/test-helpers'
import { PluginRegistry } from '@core/plugin/plugin-registry'
import { PluginStateStore } from '@core/plugin/state/plugin-state-store'
import { migrate } from '@core/session/migrations'
import { SqlitePostDeliveryRepository } from '@core/session/post-delivery-repository'
import { DownloadErrorCode } from '@shared/errors'
import {
  makeDownloadTask,
  TaskKind,
  TaskStatus,
  TaskType,
} from '@shared/types/task'
import type { TaskTerminalOccurrence } from '@shared/types/task-occurrence'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapabilityHost } from '../capabilities/interface'
import { PluginHost } from '../host/plugin-host'
import { PluginHookRuntime } from './plugin-hook-runtime'

const FIXTURE_ROOT = path.resolve(
  __dirname,
  '../../../../tests/fixtures/plugins/test.hook-delivery-runtime'
)
const WORKER_SCRIPT_PATH = path.resolve(
  __dirname,
  '../../../../dist-test/quick-js-worker.cjs'
)

describe('PluginHookRuntime integration', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  it('delivers a persisted terminal payload through the real PluginHost after the task object is gone', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'motrix-hook-runtime-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const pluginsDir = path.join(root, 'plugins')
    mkdirSync(pluginsDir)
    cpSync(FIXTURE_ROOT, path.join(pluginsDir, 'test.hook-delivery-runtime'), {
      recursive: true,
    })

    const database = new Database(':memory:')
    cleanups.push(() => {
      database.close()
    })
    migrate(database)
    const stateStore = new PluginStateStore(database)
    const registry = new PluginRegistry({
      pluginsDir,
      builtinDir: path.join(root, 'builtin'),
      stateStore,
      hostVersion: '2.5.0',
    })
    await registry.discover()
    expect(registry.loadErrors()).toEqual([])
    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: 'test.hook-delivery-runtime',
        enabled: true,
      }),
    ])

    const capabilityHost = makeStubCapabilityHost()
    Object.assign(capabilityHost, {
      fsTaskFor: () => ({}) as ReturnType<CapabilityHost['fsTaskFor']>,
      metadata: {
        getAll: async () => ({ persisted: true }),
      } as unknown as CapabilityHost['metadata'],
    })
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost,
      workerScriptPath: WORKER_SCRIPT_PATH,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    cleanups.push(() => host.shutdown())
    const activation = new ActivationDispatcher(registry, host)
    const repository = new SqlitePostDeliveryRepository(database)
    const runtime = new PluginHookRuntime({
      activation,
      registry,
      grants: { effectivePermissionsFor: async () => new Set<string>() },
      host,
      capabilityHost,
      repository,
      persistTerminal: async (_task, _occurrence, input) => {
        input.beforeCommit()
        repository.admitMany(input.postDeliveries)
      },
    })

    const now = Date.now()
    let task = makeDownloadTask({
      id: 'task-persisted-post',
      name: 'archive.zip',
      type: TaskType.Http,
      kind: TaskKind.Direct,
      status: TaskStatus.Completed,
      progress: 1,
      totalBytes: 10,
      downloadedBytes: 10,
      sizeWhenDone: 10,
      fileCount: 1,
      saveDir: root,
      filename: 'archive.zip',
      finalName: 'archive.zip',
      finalPath: path.join(root, 'archive.zip'),
      diskPath: path.join(root, 'archive.zip'),
      createdAt: now - 100,
      updatedAt: now,
      finishedAt: now,
      source: 'user',
      sourceMeta: null,
      instances: [],
    })
    const occurrence: TaskTerminalOccurrence = {
      occurrenceId: 'occurrence-persisted-post',
      type: 'terminal',
      taskId: task.id,
      fromStatus: TaskStatus.Downloading,
      toStatus: TaskStatus.Completed,
      cause: 'engine',
      errorGroup: null,
      createdAt: now,
    }

    expect(
      activation.candidatesForHook('afterComplete', { taskType: TaskType.Http })
    ).toHaveLength(1)
    await runtime.persistTerminal(task, occurrence)
    expect(
      database
        .prepare(
          'SELECT status FROM plugin_post_deliveries WHERE occurrence_id=?'
        )
        .get(occurrence.occurrenceId)
    ).toEqual({ status: 'pending' })
    task = null as unknown as typeof task
    await runtime.scheduler.drainOnce()

    const observations = await host.invokeCommand(
      'test.hook-delivery-runtime',
      'test.hook-delivery-runtime.read',
      undefined
    )
    expect(observations).toEqual([
      {
        hook: 'afterComplete',
        deliveryId: expect.stringMatching(/^post:v1:/),
        occurrenceId: occurrence.occurrenceId,
        occurredAt: occurrence.createdAt,
        metadataReadonly: true,
      },
    ])
    expect(
      database
        .prepare(
          'SELECT status FROM plugin_post_deliveries WHERE occurrence_id=?'
        )
        .get(occurrence.occurrenceId)
    ).toEqual({ status: 'delivered' })

    const errorTask = makeDownloadTask({
      id: 'task-persisted-error',
      name: 'broken.zip',
      type: TaskType.Http,
      kind: TaskKind.Direct,
      status: TaskStatus.Error,
      progress: 0.5,
      totalBytes: 10,
      downloadedBytes: 5,
      sizeWhenDone: 10,
      fileCount: 1,
      saveDir: root,
      filename: 'broken.zip',
      finalName: 'broken.zip',
      finalPath: path.join(root, 'broken.zip'),
      diskPath: path.join(root, 'broken.zip'),
      createdAt: now - 50,
      updatedAt: now + 1,
      finishedAt: now + 1,
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: 'Download failed',
      source: 'user',
      sourceMeta: null,
      instances: [],
    })
    const errorOccurrence: TaskTerminalOccurrence = {
      occurrenceId: 'occurrence-persisted-error',
      type: 'terminal',
      taskId: errorTask.id,
      fromStatus: TaskStatus.Downloading,
      toStatus: TaskStatus.Error,
      cause: 'engine',
      errorGroup: {
        errorCode: DownloadErrorCode.NetworkError,
        errorMessage: 'Download failed',
        errorDetailKey: null,
        errorDetailParams: null,
      },
      createdAt: now + 1,
    }

    expect(
      activation.candidatesForHook('onError', { taskType: TaskType.Http })
    ).toHaveLength(1)
    await runtime.persistTerminal(errorTask, errorOccurrence)
    await runtime.scheduler.drainOnce()

    expect(
      await host.invokeCommand(
        'test.hook-delivery-runtime',
        'test.hook-delivery-runtime.read',
        undefined
      )
    ).toEqual([
      {
        hook: 'afterComplete',
        deliveryId: expect.stringMatching(/^post:v1:/),
        occurrenceId: occurrence.occurrenceId,
        occurredAt: occurrence.createdAt,
        metadataReadonly: true,
      },
      {
        hook: 'onError',
        deliveryId: expect.stringMatching(/^post:v1:/),
        occurrenceId: errorOccurrence.occurrenceId,
        occurredAt: errorOccurrence.createdAt,
        metadataReadonly: true,
        errorCode: DownloadErrorCode.NetworkError,
      },
    ])
    expect(
      database
        .prepare(
          'SELECT status FROM plugin_post_deliveries WHERE occurrence_id=?'
        )
        .get(errorOccurrence.occurrenceId)
    ).toEqual({ status: 'delivered' })
  }, 30_000)
})
