// src/core/plugin/host/orchestrator.e2e.test.ts
// End-to-end integration test for the Plan C HookOrchestrator. Spawns real
// QuickJS workers loaded with role-band fixture plugins and exercises the full
// beforeCreate chain: resolve → enrich → audit, plus the fail-mode contract
// (resolve aborts, enrich/audit fail-open isolated).
//
// Each test boots a fresh registry + host so plugins don't leak between cases.
// The host is torn down at the end of every test to release worker_threads.

import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { migrate } from '@core/session/migrations'
import type { SupportedLocale } from '@shared/constants/locales'
import type { BeforeCreateHttpContextDTO } from '@shared/types/plugin-hooks'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppCapabilityHost } from '../capabilities/app'
import { I18nCapabilityHost } from '../capabilities/i18n'
import type { CapabilityHost } from '../capabilities/interface'
import { LogCapabilityHost } from '../capabilities/log'
import { HookOrchestrator } from '../hooks/hook-orchestrator'
import { PluginRegistry } from '../plugin-registry'
import { PluginStateStore } from '../state/plugin-state-store'
import { PluginHost } from './plugin-host'

const FIXTURE_ROOT = path.join(__dirname, '../../../../tests/fixtures/plugins')
const WORKER_SCRIPT_PATH = path.join(
  __dirname,
  '../../../../dist-test/quick-js-worker.cjs'
)

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

interface BootedStack {
  host: PluginHost
  orchestrator: HookOrchestrator
  rootDir: string
  shutdown(): Promise<void>
}

function buildCapHost(rootDir: string): CapabilityHost {
  const log = new LogCapabilityHost({
    pluginLogsDir: path.join(rootDir, 'logs'),
  })
  const app = new AppCapabilityHost({
    appVersion: '2.5.0',
    platform: 'linux',
    runtime: 'server',
    locale: 'en-US',
    arch: 'x64',
  })
  const i18n = new I18nCapabilityHost({ hostLanguage: 'en-US' })
  // Plan A surface only: the role-band fixtures call ctx.update which is
  // routed by the bridge's staged-effects path (not a CapabilityHost method),
  // so the remaining Plan B getters can stay as inert stubs.
  return {
    createLog: (id: string) => log.create(id),
    getTail: (id: string, n: number) => log.getTail(id, n),
    appSnapshot: () => app.snapshot(),
    i18nSnapshot: () => ({
      language: 'en-US',
      dir: 'ltr' as const,
      currentDict: {},
      fallbackDict: {},
    }),
    setLocale: (locale: SupportedLocale) => i18n.setLanguage(locale),
    onLocaleChange: (h: (lang: string) => void) => i18n.onChange(h),
    flush: () => log.flush(),
  } as unknown as CapabilityHost
}

async function bootStack(
  fixtureIds: ReadonlyArray<string>
): Promise<BootedStack> {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mhe-orch-'))
  mkdirSync(path.join(rootDir, 'plugins'))
  for (const id of fixtureIds) {
    cpSync(path.join(FIXTURE_ROOT, id), path.join(rootDir, 'plugins', id), {
      recursive: true,
    })
  }

  const db = new Database(':memory:')
  migrate(db)
  const stateStore = new PluginStateStore(db)

  const registry = new PluginRegistry({
    pluginsDir: path.join(rootDir, 'plugins'),
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

  for (const id of fixtureIds) {
    await host.activate(id)
  }

  const orchestrator = new HookOrchestrator({
    host,
    hookTimeoutMs: { series: 10_000, parallel: 30_000 },
    pluginsDir: rootDir,
    pluginStorageRootFor: (id) => `${rootDir}/${id}/storage`,
  })

  return {
    host,
    orchestrator,
    rootDir,
    async shutdown() {
      await host.shutdown()
      db.close()
    },
  }
}

function makeCtx(): BeforeCreateHttpContextDTO {
  // Cast: BeforeCreateHttpContextDTO is readonly; tests need a fresh shape.
  // The orchestrator treats it as readonly and the merger consumes it.
  return {
    type: 'http',
    sourceUrl: 'https://example.com/x',
    uris: ['https://example.com/x'],
    saveDir: '/tmp/save',
    headers: [{ name: 'User-Agent', value: 'tester' }],
    createdBy: 'user',
    requestedAt: Date.now(),
  } as BeforeCreateHttpContextDTO
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Plugin Hook Orchestrator (e2e)', () => {
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

  it('full chain: resolve + enrich + audit merge with attribution', async () => {
    stack = await bootStack([
      'test.resolve-band',
      'test.enrich-band',
      'test.audit-band',
    ])

    const initial = makeCtx()
    const result = await stack.orchestrator.runBeforeCreateHttp(
      initial,
      'task-1'
    )

    if ('aborted' in result && result.aborted) {
      throw new Error(`expected success, got abort: ${result.reason}`)
    }

    // Resolve plugin rewrote the URI list.
    expect(result.final.uris).toEqual(['https://cdn.example.com/resolved'])
    expect(result.contributors.uris).toBe('test.resolve-band')

    // Enrich plugin appended the X-Enrich header (case-insensitive de-dup
    // keeps the user-supplied UA in place).
    const headerNames = result.final.headers.map((h) => h.name)
    expect(headerNames).toContain('X-Enrich')
    expect(headerNames).toContain('User-Agent')
    expect(result.contributors.headers).toContain('test.enrich-band')

    // Audit plugin tried to mutate via ctx.update; the bridge rejected the
    // call with AuditRoleCannotMutate, so it produces no contribution.
    expect(result.contributors.headers).not.toContain('test.audit-band')
  }, 30_000)

  it('resolve throws → chain aborted, no staged effects survive', async () => {
    stack = await bootStack(['test.resolve-band-throws'])

    const result = await stack.orchestrator.runBeforeCreateHttp(
      makeCtx(),
      'task-2'
    )

    expect('aborted' in result && result.aborted).toBe(true)
    if (!('aborted' in result) || !result.aborted) return // narrow for TS
    expect(result.reason).toContain('test.resolve-band-throws')
    // Plan C surface for an abort returns ChainAborted (no `staged` /
    // `final` to inspect); TaskManager treats that as not-created.
  }, 30_000)

  it('enrich throws → chain continues, throwing plugin contributes nothing', async () => {
    stack = await bootStack(['test.enrich-band', 'test.enrich-band-throws'])

    const result = await stack.orchestrator.runBeforeCreateHttp(
      makeCtx(),
      'task-3'
    )

    expect('aborted' in result && result.aborted).toBeFalsy()
    if ('aborted' in result && result.aborted) return

    const headerNames = result.final.headers.map((h) => h.name)
    // The working enrich plugin's header is present.
    expect(headerNames).toContain('X-Enrich')
    // The throwing plugin's staged header was dropped via
    // staged.removeFromPlugin() (fail-open isolation per spec §10).
    expect(headerNames).not.toContain('X-Enrich-Throws')
    expect(result.contributors.headers).toContain('test.enrich-band')
    expect(result.contributors.headers).not.toContain('test.enrich-band-throws')
  }, 30_000)

  it('audit-role ctx.update is rejected at the bridge (worker-side throws)', async () => {
    stack = await bootStack(['test.audit-band'])

    const result = await stack.orchestrator.runBeforeCreateHttp(
      makeCtx(),
      'task-4'
    )

    // Audit plugin's throw inside ctx.update is caught by its own try/catch
    // (in the fixture). The chain still succeeds since audit failures are
    // fail-open isolated.
    expect('aborted' in result && result.aborted).toBeFalsy()
    if ('aborted' in result && result.aborted) return

    // Audit plugin contributed nothing — its mutation attempt was rejected
    // by the bridge's audit-role validator before reaching staged storage.
    expect(result.contributors.headers).not.toContain('test.audit-band')
    // The final URI list is the unmodified user input.
    expect(result.final.uris).toEqual(['https://example.com/x'])
  }, 30_000)
})
