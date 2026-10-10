// End-to-end test for the plugin beforeCreate hook wiring bug.
//
// Bug: HookOrchestrator was never instantiated and never passed into
// createDeps in src/main/ipc/commands.ts (or src/server/ipc/commands.ts).
// As a result, the entire `if (deps.orchestrator && ...)` branch in
// handleCreateTask was a dead branch in production, so resolver plugins
// silently never ran and the original URL was handed to aria2 unchanged.
//
// This test boots a real PluginRegistry + PluginHost + HookOrchestrator,
// loads the existing `test.resolve-band` fixture plugin (which rewrites
// uris[0] in beforeCreate), and asserts handleCreateTask dispatches the
// REWRITTEN URI to aria2 when the orchestrator is wired into deps.
//
// The companion `regression` case demonstrates the original bug: without
// the orchestrator in deps, the URI handed to aria2 is the unchanged
// user-supplied URL. After the wiring fix in commands.ts, that scenario
// cannot occur in production.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CapabilityHost } from '@core/plugin/capabilities/interface'
import { LogCapabilityHost } from '@core/plugin/capabilities/log'
import { HookOrchestrator } from '@core/plugin/hooks/hook-orchestrator'
import { PluginHost } from '@core/plugin/host/plugin-host'
import { PluginRegistry } from '@core/plugin/plugin-registry'
import { PluginStateStore } from '@core/plugin/state/plugin-state-store'
import { AppliedDownloadProxyPolicy } from '@core/proxy/applied-download-proxy-policy'
import { migrate } from '@core/session/migrations'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Aria2Adapter } from '../engine/aria2/aria2-adapter'
import { handleCreateTask } from './create-task-handler'

const FIXTURE_ROOT = path.join(__dirname, '../../../tests/fixtures/plugins')
const WORKER_SCRIPT_PATH = path.join(
  __dirname,
  '../../../dist-test/quick-js-worker.cjs'
)

// Minimal CapabilityHost shaped like server runtime — the resolve-band
// fixture plugin only calls hooks.beforeCreate + ctx.update so most cap
// slots can stay as noop stubs.
function buildCapHost(_rootDir: string): CapabilityHost {
  const noop = () => {}
  const noopAsync = async () => {}
  const logNoop = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  }
  return {
    createLog: (_id: string) => logNoop,
    getTail: () => [],
    clearLog: () => {},
    setLogVerbose: () => {},
    isLogVerbose: () => false,
    getLogState: () => ({ verbose: false, expiresAt: null }),
    subscribeLog: () => noop,
    appSnapshot: () => ({
      version: '2.5.0',
      platform: process.platform as 'darwin' | 'win32' | 'linux',
      runtime: 'server' as const,
      locale: 'en-US',
      arch: process.arch as 'x64' | 'arm64',
    }),
    i18nSnapshot: () => ({
      language: 'en-US',
      dir: 'ltr' as const,
      currentDict: {},
      fallbackDict: {},
    }),
    setLocale: noop,
    onLocaleChange: () => noop,
    flush: noopAsync,
    http: null as unknown as CapabilityHost['http'],
    fsTaskFor: () => null as unknown as ReturnType<CapabilityHost['fsTaskFor']>,
    fsStorageFor: () =>
      null as unknown as ReturnType<CapabilityHost['fsStorageFor']>,
    storage: null as unknown as CapabilityHost['storage'],
    metadata: null as unknown as CapabilityHost['metadata'],
    crypto: null as unknown as CapabilityHost['crypto'],
    configFor: () => null as unknown as ReturnType<CapabilityHost['configFor']>,
    lifecycle: null as unknown as CapabilityHost['lifecycle'],
    commands: null as unknown as CapabilityHost['commands'],
    notify: null as unknown as CapabilityHost['notify'],
    ffmpeg: null as unknown as CapabilityHost['ffmpeg'],
    secrets: null as unknown as CapabilityHost['secrets'],
    cookieJarFor: () =>
      null as unknown as ReturnType<CapabilityHost['cookieJarFor']>,
  } as unknown as CapabilityHost
}

// Mock fs/promises so handleCreateTask's mkdir() doesn't touch the real
// disk for the temp saveDir.
vi.mock('node:fs/promises', async () => {
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    mkdir: vi.fn(async () => undefined),
    default: { ...actual, mkdir: vi.fn(async () => undefined) },
  }
})

interface BootedStack {
  host: PluginHost
  logs: LogCapabilityHost
  orchestrator: HookOrchestrator
  rootDir: string
  pluginsDir: string
  shutdown(): Promise<void>
}

async function bootStack(
  fixtureId: string,
  rewrittenUri?: string
): Promise<BootedStack> {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mhe-hook-e2e-'))
  const pluginsDir = path.join(rootDir, 'plugins')
  mkdirSync(pluginsDir, { recursive: true })
  cpSync(path.join(FIXTURE_ROOT, fixtureId), path.join(pluginsDir, fixtureId), {
    recursive: true,
  })

  if (rewrittenUri) {
    writeFileSync(
      path.join(pluginsDir, fixtureId, 'dist/plugin.js'),
      `
      import { hooks } from 'motrix:plugin-api';
      hooks.beforeCreate(async (ctx) => {
        if (ctx.sourceUrl !== ${JSON.stringify(SOURCE_URL)} || ctx.uris[0] !== ${JSON.stringify(SOURCE_URL)}) {
          throw new Error('source query changed before hook');
        }
        ctx.update({ uris: [${JSON.stringify(rewrittenUri)}] });
      });
    `
    )
  }
  const logs = new LogCapabilityHost({
    pluginLogsDir: path.join(rootDir, 'logs'),
  })
  const db = new Database(':memory:')
  migrate(db)
  const stateStore = new PluginStateStore(db)

  const registry = new PluginRegistry({
    pluginsDir,
    builtinDir: path.join(rootDir, 'builtin'),
    stateStore,
    hostVersion: '2.5.0',
  })
  await registry.discover()

  const host = new PluginHost({
    registry,
    stateStore,
    capabilityHost: buildCapHost(rootDir),
    workerScriptPath: WORKER_SCRIPT_PATH,
    appVersion: '2.5.0',
    runtime: 'server',
    hostLanguage: 'en-US',
  })

  await host.activate(fixtureId)

  const orchestrator = new HookOrchestrator({
    host,
    createLog: (id) => logs.create(id),
    hookTimeoutMs: { series: 10_000, parallel: 30_000 },
    pluginsDir,
    pluginStorageRootFor: (id) => path.join(pluginsDir, id, 'storage'),
  })

  return {
    host,
    logs,
    orchestrator,
    rootDir,
    pluginsDir,
    async shutdown() {
      await host.shutdown()
      await logs.flush()
      db.close()
      rmSync(rootDir, { recursive: true, force: true })
    },
  }
}

type Deps = Parameters<typeof handleCreateTask>[1]

function makeBaseDeps(saveDir: string): Deps & {
  addUri: ReturnType<typeof vi.fn>
  add: ReturnType<typeof vi.fn>
} {
  const addUri = vi.fn(
    async (_uris: string[], options: Record<string, unknown>) =>
      String(options.gid)
  )
  const addTorrent = vi.fn()
  const add = vi.fn()
  // Route the create path through a real Aria2Adapter wrapping rpc spies so
  // the test still asserts on the actual aria2 wire (deps.addUri calls).
  const rpcClient = {
    addUri,
    addTorrent,
    onBtDownloadComplete: vi.fn(),
    onDownloadComplete: vi.fn(),
    onDownloadError: vi.fn(),
  }
  // The mock rpc only needs the subset Aria2Adapter touches on the create
  // path (addUri/addTorrent + the three on* subscriptions).
  const adapter = new Aria2Adapter(rpcClient as never)
  const settingsManager = {
    getApp: () => ({ defaultSaveDir: saveDir }),
    getEngine: () => ({
      performanceProfile: 'custom',
      maxConnectionPerServer: 16,
    }),
  } as unknown as Deps['settingsManager']
  const finalNamePicker = {
    pick: vi.fn(async (_dir: string, name: string) => name),
  } as unknown as Deps['finalNamePicker']
  const torrentMetaStore = {
    persist: vi.fn(),
    read: vi.fn(),
    remove: vi.fn(),
  } as unknown as Deps['torrentMetaStore']
  const taskManager = {
    add,
    getAll: vi.fn(() => []),
    getById: vi.fn(),
    getByEngineTaskId: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    setReservedEngineTaskOwner: vi.fn(),
    rollbackReservedEngineTaskOwner: vi.fn(() => true),
    reserveEngineTaskId: vi.fn(),
    releaseEngineTaskIdReservation: vi.fn(() => true),
    retireEngineTaskIdReservation: vi.fn(() => true),
  } as unknown as Deps['taskManager']
  const eventBus = { emit: vi.fn() }
  return {
    adapter,
    settingsManager,
    directResourceProxyPolicy: new AppliedDownloadProxyPolicy({ noProxy: '' }),
    finalNamePicker,
    torrentMetaStore,
    taskManager,
    activityRecorder: {
      recordSubmitted: vi.fn(),
      recordDownloadCompleted: vi.fn(),
    },
    eventBus,
    publishTaskUpdate: vi.fn(() => {
      eventBus.emit('event:taskUpdated', [])
    }),
    addUri,
    add,
  } as Deps & {
    addUri: ReturnType<typeof vi.fn>
    add: ReturnType<typeof vi.fn>
  }
}

const SOURCE_URL = 'https://source.example/watch?id=video'
// test.resolve-band rewrites uris[0] to this fixed direct URL.
const RESOLVED_URL = 'https://cdn.example.com/resolved'

describe('handleCreateTask + beforeCreate hook wiring', () => {
  let stack: BootedStack | null = null

  beforeEach(() => {
    stack = null
  })

  afterEach(async () => {
    if (stack) {
      await stack.shutdown()
      stack = null
    }
  })

  it.each([
    ['https://httpbin.org/get?a=1', false],
    [
      'https://drive.usercontent.google.com/download?id=test-ID&export=download&confirm=t',
      false,
    ],
    [
      'https://cdn.example.com/download?item=a%2fb+X&item=2&empty=&sig=private-signature',
      false,
    ],
    [
      'https://cdn.example.com/download?item=a%2fb+X&item=2&empty=&sig=private-signature',
      true,
    ],
  ])(
    'preserves %s through QuickJS and aria2 while recording scoped diagnostics (verbose=%s)',
    async (uri, verbose) => {
      stack = await bootStack('test.resolve-band', uri as string)
      stack.logs.setVerbose('test.resolve-band', verbose as boolean)
      const saveDir = path.join(stack.rootDir, 'save')
      const deps = makeBaseDeps(saveDir)
      await handleCreateTask(
        { type: 'http', uris: [SOURCE_URL], saveDir, headers: [] },
        { ...deps, orchestrator: stack.orchestrator }
      )
      expect(deps.addUri.mock.calls[0][0]).toEqual([uri])
      const records = stack.logs.getTail('test.resolve-band', 10)
      expect(records.map((record) => record.stage)).toEqual([
        'beforeCreate.input',
        'beforeCreate.output',
        'engine.dispatch',
      ])
      expect(records[0].uris).toEqual([SOURCE_URL])
      const logged = verbose
        ? uri
        : (uri as string).replace('sig=private-signature', 'sig=[redacted]')
      expect(records[1].uris).toEqual([logged])
      expect(records[2].uris).toEqual([logged])
      expect(records[2].gid).toBe(deps.addUri.mock.calls[0][1].gid)
      expect(new Set(records.map((record) => record.taskId)).size).toBe(1)
      expect(stack.logs.getTail('other.plugin', 10)).toEqual([])
    },
    30_000
  )

  it('rewrites the source URL when the orchestrator is wired', async () => {
    stack = await bootStack('test.resolve-band')
    const saveDir = path.join(stack.rootDir, 'save')
    const deps = makeBaseDeps(saveDir)
    const fullDeps: Deps = { ...deps, orchestrator: stack.orchestrator }

    await handleCreateTask(
      {
        type: 'http',
        uris: [SOURCE_URL],
        saveDir,
        headers: [],
      },
      fullDeps
    )

    expect(deps.addUri).toHaveBeenCalledOnce()
    const [dispatchedUris] = deps.addUri.mock.calls[0]
    // This is the assertion that fails for the original bug — aria2
    // would have received the raw watch URL and downloaded the HTML.
    expect(dispatchedUris).toEqual([RESOLVED_URL])
  }, 30_000)

  it('regression: leaves URL unchanged when orchestrator is missing from deps (pre-fix bug)', async () => {
    // This is the production state before the wiring fix: createDeps was
    // built without the orchestrator slot. handleCreateTask's hook chain
    // condition `if (deps.orchestrator && ...)` short-circuited to false
    // and the user's source URL went straight to aria2.
    stack = await bootStack('test.resolve-band')
    const saveDir = path.join(stack.rootDir, 'save')
    const deps = makeBaseDeps(saveDir)
    // Intentionally NOT spreading orchestrator into deps.

    await handleCreateTask(
      {
        type: 'http',
        uris: [SOURCE_URL],
        saveDir,
        headers: [],
      },
      deps
    )

    expect(deps.addUri).toHaveBeenCalledOnce()
    const [dispatchedUris] = deps.addUri.mock.calls[0]
    // Unchanged — this is the failing-for-the-user behavior the fix removes.
    expect(dispatchedUris).toEqual([SOURCE_URL])
  }, 30_000)
})
