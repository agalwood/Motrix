// src/core/plugin/host/test-helpers.ts
// Shared test helpers for CapabilityBridge integration tests.
// Used by Task 2 (I18 gate) and Task 21 (allcaps e2e).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_LOCALE } from '@shared/constants/locales'
import type { PluginManifest } from '@shared/types/plugin'
import type { CapabilityHost } from '../capabilities/interface'
import { CapabilityBridge } from './capability-bridge'

export interface SpawnedBridge {
  registrations: Array<{ kind: 'hook' | 'command'; key: string }>
  errorCode?: string
  errorMessage?: string
  bridge: CapabilityBridge
  /**
   * Invoke a registered command inside the plugin VM and return its result.
   * Wired via the BridgeExecuteCommand / BridgeExecuteCommandResult protocol
   * added in Task 21 (option b).
   */
  callPlugin(commandId: string, args: unknown): Promise<unknown>
}

const WORKER_SCRIPT_PATH = path.resolve(
  __dirname,
  '../../../../dist-test/quick-js-worker.cjs'
)

/** Stub CapabilityHost: covers all Plan A + Plan B members with no-ops. */
export function makeStubCapabilityHost(): CapabilityHost {
  const noop = () => {}
  const noopAsync = async () => {}
  return {
    // ── Plan A ────────────────────────────────────────────────────────────
    createLog: (_pluginId: string) => ({
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
    }),
    getTail: (_pluginId: string, _limit: number) => [],
    clearLog: (_pluginId: string) => {},
    setLogVerbose: (_pluginId: string, _verbose: boolean) => {},
    isLogVerbose: (_pluginId: string) => false,
    subscribeLog: () => noop,
    appSnapshot: () => ({
      version: '2.5.0',
      platform: process.platform as 'darwin' | 'win32' | 'linux',
      runtime: 'server' as const,
      locale: DEFAULT_LOCALE,
      arch: process.arch as 'x64' | 'arm64',
    }),
    i18nSnapshot: (_pluginId: string) => ({
      language: DEFAULT_LOCALE,
      dir: 'ltr' as const,
      currentDict: {},
      fallbackDict: {},
    }),
    setLocale: noop,
    onLocaleChange: (_handler: (lang: string) => void) => noop,
    flush: noopAsync,
    // ── Plan B stubs ──────────────────────────────────────────────────────
    // These no-ops satisfy the interface for tests that don't exercise Plan B.
    // Task 21 (allcaps e2e) will replace this stub with a real capability host.
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
  }
}

/**
 * Instantiate a CapabilityBridge around the given fixture directory, wait for
 * either `ready` or the first `fatal`, then return a SpawnedBridge.
 *
 * @param fixtureDir  Absolute path to a plugin fixture directory that contains
 *                    `motrix-plugin.json` and the bundle path listed in `main`.
 * @param opts.capabilityHost  Override the default stub host (e.g. for allcaps e2e).
 * @param opts.beforeReady  Hook invoked immediately after bridge construction.
 * @param opts.expectFatal  If true, a fatal is expected and a missing fatal is
 *                          treated as a test concern (the promise still resolves).
 * @param opts.timeoutMs    Override the 5-second default resolution timeout.
 */
export async function spawnTestBridge(
  fixtureDir: string,
  opts: {
    expectFatal?: boolean
    timeoutMs?: number
    capabilityHost?: CapabilityHost
    beforeReady?: (bridge: CapabilityBridge) => void
  } = {}
): Promise<SpawnedBridge> {
  const timeoutMs = opts.timeoutMs ?? 5_000

  const manifestRaw = readFileSync(
    path.join(fixtureDir, 'motrix-plugin.json'),
    'utf8'
  )
  const manifest = JSON.parse(manifestRaw) as PluginManifest
  const bundleSource = readFileSync(
    path.join(fixtureDir, manifest.main),
    'utf8'
  )

  const registrations: Array<{ kind: 'hook' | 'command'; key: string }> = []
  let resolved = false

  // bridge is assigned synchronously inside the Promise executor before any
  // async callbacks can fire, so the definite-assignment assertion is safe.
  // Declaring it here lets the timeout callback reference it for disposal.
  let bridge: CapabilityBridge

  const result = await new Promise<SpawnedBridge>((resolve, reject) => {
    const timer = setTimeout(async () => {
      if (resolved) return
      resolved = true
      try {
        await bridge.dispose()
      } catch {
        /* swallow — worker may already be dead */
      }
      reject(new Error(`spawnTestBridge timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    bridge = new CapabilityBridge(
      {
        pluginId: manifest.id,
        manifest,
        bundleSource,
        capabilityHost: opts.capabilityHost ?? makeStubCapabilityHost(),
        workerScriptPath: WORKER_SCRIPT_PATH,
        heapMB: 32,
        appVersion: '2.5.0',
        runtime: 'server',
        hostLanguage: DEFAULT_LOCALE,
      },
      {
        onRegister(kind, key) {
          registrations.push({ kind, key })
        },
        onFatal(code, message) {
          if (!resolved) {
            resolved = true
            clearTimeout(timer)
            resolve({
              registrations,
              errorCode: code,
              errorMessage: message,
              bridge,
              callPlugin: (commandId, args) =>
                bridge.callPlugin(commandId, args),
            })
          }
        },
        onReady() {
          if (!resolved) {
            resolved = true
            clearTimeout(timer)
            resolve({
              registrations,
              bridge,
              callPlugin: (commandId, args) =>
                bridge.callPlugin(commandId, args),
            })
          }
        },
      }
    )
    opts.beforeReady?.(bridge)
  })

  return result
}
