import { mkdtempSync, writeFileSync } from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SupportedLocale } from '@shared/constants/locales'
import type { PluginManifest } from '@shared/types/plugin'
import { describe, expect, it, vi } from 'vitest'
import { AppCapabilityHost } from '../capabilities/app'
import { HttpCapabilityHost } from '../capabilities/http'
import type { CapabilityHost } from '../capabilities/interface'
import { LogCapabilityHost } from '../capabilities/log'
import { StagedEffectStore } from '../hooks/staged-effects'
import { CapabilityBridge } from './capability-bridge'

const PLUGIN_ID = 'test.http-scope'

async function createBlockingServer(): Promise<{
  server: http.Server
  url: string
  requestStarted: Promise<void>
  connectionClosed: Promise<void>
}> {
  let markStarted!: () => void
  let markClosed!: () => void
  const requestStarted = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const connectionClosed = new Promise<void>((resolve) => {
    markClosed = resolve
  })
  const server = http.createServer((request, response) => {
    markStarted()
    request.once('aborted', markClosed)
    response.once('close', markClosed)
    // Deliberately never respond. Only a real transport abort can settle this.
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    server,
    url: `http://127.0.0.1:${address.port}/blocked`,
    requestStarted,
    connectionClosed,
  }
}

function writeHttpHookWorker(url: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'motrix-http-scope-worker-'))
  const file = path.join(dir, 'worker.cjs')
  writeFileSync(
    file,
    `
const { parentPort } = require('node:worker_threads')
let active
parentPort.on('message', (msg) => {
  if (msg.type === 'init') parentPort.postMessage({ type: 'ready' })
  if (msg.type === 'event' && msg.event === 'hookEnter') {
    active = msg
    parentPort.postMessage({
      type: 'call', id: 1, capability: 'http', method: 'get',
      args: [${JSON.stringify(url)}],
      invocationId: msg.invocationId,
      callChainId: msg.callChainId,
      permissionGeneration: msg.permissionGeneration,
    })
  }
  if (msg.type === 'response' && msg.id === 1 && !msg.ok) {
    parentPort.postMessage({
      type: 'event', event: 'hookExit', ok: false,
      invocationId: active.invocationId,
      callChainId: active.callChainId,
      permissionGeneration: active.permissionGeneration,
      error: msg.error,
    })
  }
})
`
  )
  return file
}

function createBridge(url: string): CapabilityBridge {
  const dir = mkdtempSync(path.join(tmpdir(), 'motrix-http-scope-'))
  const log = new LogCapabilityHost({
    pluginLogsDir: path.join(dir, 'plugin-logs'),
  })
  const app = new AppCapabilityHost({
    appVersion: '2.5.0',
    platform: 'linux',
    runtime: 'server',
    locale: 'en-US',
    arch: 'x64',
  })
  const capabilityHost = {
    createLog: (id: string) => log.create(id),
    getTail: (id: string, n: number) => log.getTail(id, n),
    appSnapshot: () => app.snapshot(),
    i18nSnapshot: () => ({
      language: 'en-US',
      dir: 'ltr' as const,
      currentDict: {},
      fallbackDict: {},
    }),
    setLocale: (_locale: SupportedLocale) => undefined,
    onLocaleChange: () => () => undefined,
    flush: () => log.flush(),
    http: new HttpCapabilityHost(),
    cookieJarFor: () => undefined,
  } as unknown as CapabilityHost
  const manifest: PluginManifest = {
    manifestVersion: 1,
    id: PLUGIN_ID,
    name: 'HTTP scope test',
    version: '1.0.0',
    description: '',
    categories: [],
    engines: { motrix: '*' },
    main: 'dist/plugin.js',
    permissions: ['http'],
    hostPermissions: [`${new URL(url).protocol}//127.0.0.1/*`],
    activationEvents: [],
    contributes: {},
  }
  return new CapabilityBridge({
    pluginId: PLUGIN_ID,
    manifest,
    bundleSource: '',
    capabilityHost,
    workerScriptPath: writeHttpHookWorker(url),
    heapMB: 32,
    appVersion: '2.5.0',
    runtime: 'server',
    hostLanguage: 'en-US',
    permissionGeneration: 7,
    effectivePermissions: new Set(['http']),
  })
}

function startHook(bridge: CapabilityBridge, signal: AbortSignal) {
  bridge.setHookContext({
    fsTaskHost: {} as ReturnType<CapabilityHost['fsTaskFor']>,
    taskId: 'task-http-scope',
    phase: 'beforeCreate',
    staged: new StagedEffectStore(),
    role: 'enrich',
    saveDir: '/downloads',
    pluginStorageRoot: '/plugins/test.http-scope',
    effectivePermissions: new Set(['http']),
  })
  return bridge.callHook(
    'beforeCreate',
    'task-http-scope',
    signal,
    5_000,
    {
      type: 'http',
      sourceUrl: 'https://source.example/file',
      createdBy: 'user',
      requestedAt: 1,
      uris: ['https://source.example/file'],
      saveDir: '/downloads',
      headers: [],
    },
    {},
    {
      invocationId: 'invocation-http-scope',
      callChainId: 'chain-http-scope',
      permissionGeneration: 7,
    }
  )
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

describe('CapabilityBridge invocation-scoped HTTP', () => {
  it('aborts the real blocking transport when the Hook scope is aborted', async () => {
    const transport = await createBlockingServer()
    const bridge = createBridge(transport.url)
    const controller = new AbortController()
    try {
      const hook = startHook(bridge, controller.signal)
      void hook.catch(() => undefined)
      await transport.requestStarted
      expect(bridge.operationState()).toMatchObject({ httpOperations: 1 })

      controller.abort()

      await expect(hook).rejects.toMatchObject({ code: 'plugin.hook.aborted' })
      await transport.connectionClosed
      await vi.waitFor(() => {
        expect(bridge.operationState()).toMatchObject({ httpOperations: 0 })
      })
    } finally {
      await bridge.dispose()
      await closeServer(transport.server)
    }
  })

  it('aborts and drains the real blocking transport during bridge teardown', async () => {
    const transport = await createBlockingServer()
    const bridge = createBridge(transport.url)
    const controller = new AbortController()
    try {
      const hook = startHook(bridge, controller.signal)
      void hook.catch(() => undefined)
      await transport.requestStarted

      await bridge.dispose()

      await expect(hook).rejects.toMatchObject({
        code: 'plugin.runtime.bridge_disposed',
      })
      await transport.connectionClosed
      expect(bridge.operationState()).toMatchObject({ httpOperations: 0 })
    } finally {
      await bridge.dispose()
      await closeServer(transport.server)
    }
  })
})
