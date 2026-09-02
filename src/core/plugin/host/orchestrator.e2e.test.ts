import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { ConfigCapabilityHost } from '@core/plugin/capabilities/config'
import { FsTaskCapabilityHost } from '@core/plugin/capabilities/fs-task'
import { HttpCapabilityHost } from '@core/plugin/capabilities/http'
import {
  CookieJar,
  ensureCookieJarSchema,
} from '@core/plugin/capabilities/http-cookies'
import {
  ensureMetadataSchema,
  MetadataCapabilityHost,
} from '@core/plugin/capabilities/metadata'
import {
  artifactContentEquals,
  artifactIdentityEquals,
  readArtifactIdentity,
} from '@core/plugin/finalize/artifact-identity'
import { ArtifactMutationLeaseCoordinator } from '@core/plugin/finalize/artifact-mutation-lease'
import { NativeFinalizeFilesystemAdapter } from '@core/plugin/finalize/filesystem-adapter'
import {
  FinalizeCommitter,
  type FinalizeJournalRecord,
} from '@core/plugin/finalize/finalize-committer'
import { freezeHookPlan } from '@core/plugin/finalize/hook-plan'
import { NativeFinalizeArtifactOperations } from '@core/plugin/finalize/native-artifact-operations'
import { HookOrchestrator } from '@core/plugin/hooks/hook-orchestrator'
import { PluginRegistry } from '@core/plugin/plugin-registry'
import { PluginStateStore } from '@core/plugin/state/plugin-state-store'
import { migrate } from '@core/session/migrations'
import type {
  BeforeCreateHttpContextDTO,
  BeforeFinalizeContextDTO,
  PluginHookTask,
} from '@shared/types/plugin-hooks'
import Database from 'better-sqlite3'
import { Agent, type Dispatcher } from 'undici'
import { afterEach, describe, expect, it } from 'vitest'
import { ActivationDispatcher } from './activation-dispatcher'
import { PluginHost } from './plugin-host'
import { makeStubCapabilityHost } from './test-helpers'

const ROOT = path.resolve(__dirname, '../../../..')
const BUILTIN_DIR = path.join(ROOT, 'dist/builtin-plugins')
const WORKER_SCRIPT_PATH = path.join(ROOT, 'dist-test/quick-js-worker.cjs')
const NATIVE_BINARY = path.join(
  ROOT,
  'packages/finalize-fs/target/debug',
  process.platform === 'win32' ? 'motrix-finalize-fs.exe' : 'motrix-finalize-fs'
)
const TLS_KEY = path.join(
  ROOT,
  'src/server/bridge/__fixtures__/motrix.test-key.pem'
)
const TLS_CERT = path.join(
  ROOT,
  'src/server/bridge/__fixtures__/motrix.test-cert.pem'
)

interface Harness {
  root: string
  database: Database.Database
  metadata: MetadataCapabilityHost
  registry: PluginRegistry
  stateStore: PluginStateStore
  host: PluginHost
  orchestrator: HookOrchestrator
  logs: Array<{ level: string; message: string; fields?: unknown }>
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function makeHarness(
  input: {
    dispatcher?: Dispatcher
    config?: Record<string, Record<string, unknown>>
  } = {}
): Promise<Harness> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'motrix-builtin-hooks-'))
  )
  const pluginsDir = path.join(root, 'plugins')
  await mkdir(pluginsDir)
  cleanups.push(() => rm(root, { recursive: true, force: true }))

  const database = new Database(':memory:')
  migrate(database)
  ensureCookieJarSchema(database)
  ensureMetadataSchema(database)
  cleanups.push(() => {
    database.close()
  })

  const stateStore = new PluginStateStore(database)
  const registry = new PluginRegistry({
    pluginsDir,
    builtinDir: BUILTIN_DIR,
    stateStore,
    hostVersion: '2.5.0',
  })
  await registry.discover()
  expect(registry.loadErrors()).toEqual([])

  const metadata = new MetadataCapabilityHost({ db: database })
  const capabilityHost = makeStubCapabilityHost()
  const logs: Harness['logs'] = []
  Object.assign(capabilityHost, {
    createLog: () => ({
      trace: (message: string, fields?: unknown) =>
        logs.push({ level: 'trace', message, fields }),
      debug: (message: string, fields?: unknown) =>
        logs.push({ level: 'debug', message, fields }),
      info: (message: string, fields?: unknown) =>
        logs.push({ level: 'info', message, fields }),
      warn: (message: string, fields?: unknown) =>
        logs.push({ level: 'warn', message, fields }),
      error: (message: string, fields?: unknown) =>
        logs.push({ level: 'error', message, fields }),
      fatal: (message: string, fields?: unknown) =>
        logs.push({ level: 'fatal', message, fields }),
    }),
    http: new HttpCapabilityHost({ dispatcher: input.dispatcher }),
    metadata,
    configFor: (pluginId: string) =>
      new ConfigCapabilityHost({
        pluginId,
        readValues: () => input.config?.[pluginId] ?? {},
        schemaDefaults: {},
        secretFields: new Set(),
      }),
    fsTaskFor: (saveDir: string, filePath: string) =>
      new FsTaskCapabilityHost({ saveDir, filePath }),
    cookieJarFor: (pluginId: string) => new CookieJar(database, pluginId),
  })

  const host = new PluginHost({
    registry,
    stateStore,
    capabilityHost,
    workerScriptPath: WORKER_SCRIPT_PATH,
    idleDisposeMs: 1,
    appVersion: '2.5.0',
    runtime: 'server',
    hostLanguage: 'en-US',
  })
  cleanups.push(() => host.shutdown())
  const activation = new ActivationDispatcher(registry, host)
  const orchestrator = new HookOrchestrator({
    host,
    activationDispatcher: activation,
    capabilityHost,
    hookTimeoutMs: { series: 10_000, parallel: 10_000 },
    pluginsDir,
    pluginStorageRootFor: (pluginId) =>
      path.join(pluginsDir, pluginId, 'storage'),
  })
  return {
    root,
    database,
    metadata,
    registry,
    stateStore,
    host,
    orchestrator,
    logs,
  }
}

async function createOriginPreservingLoopback(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ dispatcher: Agent; close(): Promise<void> }> {
  const server = https.createServer(
    {
      key: await readFile(TLS_KEY),
      cert: await readFile(TLS_CERT),
    },
    handler
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('loopback TLS server did not expose a TCP port')
  }
  const dispatcher = new Agent({
    connect: (_options, callback) => {
      let settled = false
      const socket = tls.connect({
        host: '127.0.0.1',
        port: address.port,
        servername: 'localhost',
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
      })
      socket.once('secureConnect', () => {
        if (settled) return
        settled = true
        callback(null, socket)
      })
      socket.once('error', (error) => {
        if (settled) return
        settled = true
        callback(error, null)
      })
      return socket
    },
  })
  return {
    dispatcher,
    async close() {
      await dispatcher.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

function enableOnly(harness: Harness, pluginId: string): void {
  for (const plugin of harness.registry.list()) {
    harness.stateStore.setEnabled(plugin.id, plugin.id === pluginId)
    harness.registry.refreshState(plugin.id)
  }
}

function beforeCreate(
  taskId: string,
  url: string,
  saveDir: string
): BeforeCreateHttpContextDTO {
  return {
    schemaVersion: 1,
    invocationId: `acceptance:${taskId}`,
    taskId,
    type: 'http',
    sourceUrl: url,
    uris: [url],
    saveDir,
    headers: [],
    createdBy: 'user',
    requestedAt: 1_700_000_000_000,
  }
}

function taskSnapshot(input: {
  id: string
  type: PluginHookTask['type']
  kind: PluginHookTask['kind']
  saveDir: string
  filePath: string
}): PluginHookTask {
  return {
    schemaVersion: 1,
    id: input.id,
    name: path.basename(input.filePath),
    type: input.type,
    kind: input.kind,
    status: 'finalizing',
    filePath: input.filePath,
    saveDir: input.saveDir,
    filename: path.basename(input.filePath),
    progress: 100,
    totalBytes: 7,
    downloadedBytes: 7,
    uploadedBytes: 0,
    sizeWhenDone: 7,
    fileCount: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    finishedAt: null,
    category: null,
    infoHash: input.type === 'bt' ? 'a'.repeat(40) : null,
    error: null,
  }
}

function beforeFinalize(input: {
  task: PluginHookTask
  sourceUrl: string
}): BeforeFinalizeContextDTO {
  return {
    schemaVersion: 1,
    invocationId: `acceptance:${input.task.id}`,
    taskId: input.task.id,
    sourceUrl: input.sourceUrl,
    createdBy: 'user',
    requestedAt: 1_700_000_000_000,
    task: input.task,
    inputFilePath: input.task.filePath,
    filePath: input.task.filePath,
    targetFilePath: input.task.filePath,
  }
}

describe('locked builtin bundles through PluginHost + QuickJS Hooks', () => {
  it('scraper-hook performs real HEAD+GET and resolves a nested relative archive', async () => {
    const requests: Array<{ method: string; host: string; path: string }> = []
    const loopback = await createOriginPreservingLoopback(
      (request, response) => {
        requests.push({
          method: request.method ?? '',
          host: request.headers.host ?? '',
          path: request.url ?? '',
        })
        if (
          request.headers.host !== 'example.test' ||
          request.url !== '/catalog/deep/page.html'
        ) {
          response.writeHead(421).end()
          return
        }
        response.setHeader('content-type', 'text/html; charset=utf-8')
        if (request.method === 'HEAD') {
          response.writeHead(200).end()
          return
        }
        if (request.method === 'GET') {
          response
            .writeHead(200)
            .end('<html><a href="../archives/release.zip">download</a></html>')
          return
        }
        response.writeHead(405).end()
      }
    )
    cleanups.push(() => loopback.close())

    const harness = await makeHarness({
      dispatcher: loopback.dispatcher,
      config: {
        'motrix.scraper-hook': { enabled: true, maxBodyBytes: 64 << 10 },
      },
    })
    enableOnly(harness, 'motrix.scraper-hook')
    const taskId = 'builtin-scraper-task'
    const result = await harness.orchestrator.runBeforeCreateHttp(
      beforeCreate(
        taskId,
        'https://example.test/catalog/deep/page.html',
        harness.root
      ),
      taskId
    )

    if (result.aborted) throw new Error(result.reason)
    expect(harness.logs.filter((entry) => entry.level === 'warn')).toEqual([])
    expect(requests).toEqual([
      {
        method: 'HEAD',
        host: 'example.test',
        path: '/catalog/deep/page.html',
      },
      {
        method: 'GET',
        host: 'example.test',
        path: '/catalog/deep/page.html',
      },
    ])
    expect(result.final.uris).toEqual([
      'https://example.test/catalog/archives/release.zip',
    ])
  }, 30_000)

  it('url-resolver keeps the Commons API transport authorized and emits the API-selected upload URL', async () => {
    const requests: Array<{ method: string; host: string; path: string }> = []
    const loopback = await createOriginPreservingLoopback(
      (request, response) => {
        const requestPath = request.url ?? ''
        const parsed = new URL(requestPath, 'https://commons.wikimedia.org')
        requests.push({
          method: request.method ?? '',
          host: request.headers.host ?? '',
          path: requestPath,
        })
        if (
          request.method !== 'GET' ||
          request.headers.host !== 'commons.wikimedia.org' ||
          parsed.pathname !== '/w/api.php' ||
          parsed.searchParams.get('action') !== 'query' ||
          parsed.searchParams.get('format') !== 'json' ||
          parsed.searchParams.get('prop') !== 'imageinfo' ||
          parsed.searchParams.get('iiprop') !== 'url' ||
          parsed.searchParams.get('titles') !== 'File:Example.jpg'
        ) {
          response.writeHead(421).end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            query: {
              pages: {
                1: {
                  imageinfo: [
                    {
                      url: 'https://upload.wikimedia.org/wikipedia/commons/example.jpg',
                    },
                  ],
                },
              },
            },
          })
        )
      }
    )
    cleanups.push(() => loopback.close())

    const harness = await makeHarness({ dispatcher: loopback.dispatcher })
    enableOnly(harness, 'motrix.url-resolver')
    const taskId = 'builtin-resolver-task'
    const result = await harness.orchestrator.runBeforeCreateHttp(
      beforeCreate(
        taskId,
        'https://commons.wikimedia.org/wiki/File:Example.jpg',
        harness.root
      ),
      taskId
    )

    if (result.aborted) throw new Error(result.reason)
    expect(harness.logs.filter((entry) => entry.level === 'warn')).toEqual([])
    expect(result.final.uris).toEqual([
      'https://upload.wikimedia.org/wikipedia/commons/example.jpg',
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'GET',
      host: 'commons.wikimedia.org',
    })
  }, 30_000)

  it('filename-template reads nested metadata and reactivates after idle disposal', async () => {
    const harness = await makeHarness({
      config: {
        'motrix.filename-template': {
          template: '{{meta.release.channel}}-{{title}}',
        },
      },
    })
    enableOnly(harness, 'motrix.filename-template')
    const taskId = 'builtin-filename-task'
    const source = path.join(harness.root, 'original.zip')
    await writeFile(source, 'payload')
    await harness.metadata.set(taskId, 'motrix.filename-template', 'release', {
      channel: 'nightly',
    })
    const dto = beforeFinalize({
      task: taskSnapshot({
        id: taskId,
        type: 'http',
        kind: 'direct',
        saveDir: harness.root,
        filePath: source,
      }),
      sourceUrl: 'https://example.test/original.zip',
    })

    const first = await harness.orchestrator.runBeforeFinalize(dto, taskId)
    if (first.aborted) throw new Error(first.reason)
    expect(first.finalFilePath).toBe(
      path.join(harness.root, 'nightly-original.zip')
    )
    expect(harness.host.isActive('motrix.filename-template')).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 5))
    harness.host.__sweepIdleForTest()
    for (
      let attempt = 0;
      attempt < 50 && !harness.host.isQuiescent('motrix.filename-template');
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(harness.host.isQuiescent('motrix.filename-template')).toBe(true)

    const second = await harness.orchestrator.runBeforeFinalize(dto, taskId)
    if (second.aborted) throw new Error(second.reason)
    expect(second.finalFilePath).toBe(first.finalFilePath)
    expect(harness.host.isActive('motrix.filename-template')).toBe(true)
  }, 30_000)
})

describe.runIf(existsSync(NATIVE_BINARY) && process.platform !== 'win32')(
  'filename-template Hook output at the native no-clobber commit boundary',
  () => {
    async function commitSelectedTarget(input: {
      sourcePath: string
      targetPath: string
      saveDir: string
      taskId: string
    }): Promise<void> {
      const adapter = new NativeFinalizeFilesystemAdapter(NATIVE_BINARY)
      cleanups.push(() => adapter.dispose())
      const fs = new NativeFinalizeArtifactOperations(adapter)
      await fs.assertSupported()
      const repository = {
        prepare: async (_record: FinalizeJournalRecord) => undefined,
        checkpoint: async () => undefined,
        advance: async () => undefined,
        commitTerminal: async () => undefined,
        quarantine: async () => undefined,
        listRecoverable: async () => [],
      }
      const committer = new FinalizeCommitter({
        leases: new ArtifactMutationLeaseCoordinator([]),
        repository,
        fs,
        privatePathFor: (plan) =>
          path.join(plan.saveDir, '.motrix-finalize', `${plan.planId}.target`),
        rollbackPathFor: (plan) =>
          path.join(
            plan.saveDir,
            '.motrix-finalize',
            `${plan.planId}.rollback`
          ),
        exactIdentity: artifactIdentityEquals,
        sameContent: artifactContentEquals,
      })
      await committer.commit(
        freezeHookPlan({
          planId: randomUUID(),
          taskId: input.taskId,
          saveDir: input.saveDir,
          sourcePath: input.sourcePath,
          targetPath: input.targetPath,
          sourceIdentity: await readArtifactIdentity(input.sourcePath),
          metadataOps: [],
          contributors: ['motrix.filename-template'],
        })
      )
    }

    for (const artifact of ['file', 'BT directory'] as const) {
      it(`commits the Hook-selected ${artifact} rename and never clobbers an existing target`, async () => {
        const harness = await makeHarness({
          config: {
            'motrix.filename-template': {
              template: '{{meta.release.channel}}-{{title}}',
            },
          },
        })
        enableOnly(harness, 'motrix.filename-template')
        const isDirectory = artifact === 'BT directory'
        const taskId = isDirectory ? 'builtin-bt-commit' : 'builtin-file-commit'
        const source = path.join(
          harness.root,
          isDirectory ? 'original-tree' : 'original.zip'
        )
        if (isDirectory) {
          await mkdir(path.join(source, 'nested'), { recursive: true })
          await writeFile(path.join(source, 'nested', 'payload'), 'payload')
        } else {
          await writeFile(source, 'payload')
        }
        await harness.metadata.set(
          taskId,
          'motrix.filename-template',
          'release',
          { channel: 'nightly' }
        )
        const task = taskSnapshot({
          id: taskId,
          type: isDirectory ? 'bt' : 'http',
          kind: isDirectory ? 'bt' : 'direct',
          saveDir: harness.root,
          filePath: source,
        })
        const hook = await harness.orchestrator.runBeforeFinalize(
          beforeFinalize({
            task,
            sourceUrl: isDirectory
              ? `urn:btih:${'a'.repeat(40)}`
              : 'https://example.test/original.zip',
          }),
          taskId
        )
        if (hook.aborted) throw new Error(hook.reason)
        const target = hook.finalFilePath
        if (!target) throw new Error('builtin did not select a finalize path')

        await commitSelectedTarget({
          sourcePath: source,
          targetPath: target,
          saveDir: harness.root,
          taskId,
        })
        expect(
          await readFile(
            isDirectory ? path.join(target, 'nested/payload') : target,
            'utf8'
          )
        ).toBe('payload')
        expect(existsSync(source)).toBe(false)

        const competing = path.join(
          harness.root,
          isDirectory ? 'competing-tree' : 'competing.zip'
        )
        if (isDirectory) {
          await mkdir(competing)
          await writeFile(path.join(competing, 'payload'), 'competing')
        } else {
          await writeFile(competing, 'competing')
        }
        await expect(
          commitSelectedTarget({
            sourcePath: competing,
            targetPath: target,
            saveDir: harness.root,
            taskId: `${taskId}-conflict`,
          })
        ).rejects.toThrow('quarantined')
        expect(
          await readFile(
            isDirectory ? path.join(target, 'nested/payload') : target,
            'utf8'
          )
        ).toBe('payload')
        expect(existsSync(competing)).toBe(true)
      }, 30_000)
    }
  }
)
