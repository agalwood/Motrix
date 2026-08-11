import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { migrate } from '@core/session/migrations'
import type { SupportedLocale } from '@shared/constants/locales'
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { AppCapabilityHost } from '../capabilities/app'
import { I18nCapabilityHost } from '../capabilities/i18n'
import type { CapabilityHost } from '../capabilities/interface'
import { LogCapabilityHost } from '../capabilities/log'
import { PluginRegistry } from '../plugin-registry'
import { PluginStateStore } from '../state/plugin-state-store'
import { ActivationDispatcher } from './activation-dispatcher'
import { PluginHost } from './plugin-host'

const FIXTURE_DIR = path.join(
  __dirname,
  '../../../../tests/fixtures/plugins/test.echo'
)
const WORKER_SCRIPT_PATH = path.join(
  __dirname,
  '../../../../dist-test/quick-js-worker.cjs'
)

describe('Plugin runtime end-to-end (real QuickJS)', () => {
  it('boots fixture plugin and routes log.info through the bridge', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mhe-'))
    mkdirSync(path.join(root, 'plugins'))
    cpSync(FIXTURE_DIR, path.join(root, 'plugins', 'test.echo'), {
      recursive: true,
    })

    const db = new Database(':memory:')
    migrate(db)
    const stateStore = new PluginStateStore(db)

    const registry = new PluginRegistry({
      pluginsDir: path.join(root, 'plugins'),
      builtinDir: path.join(root, 'builtin'),
      stateStore,
      hostVersion: '2.5.0',
    })
    await registry.discover()
    expect(registry.list().map((p) => p.id)).toEqual(['test.echo'])

    const log = new LogCapabilityHost({
      pluginLogsDir: path.join(root, 'logs'),
    })
    const app = new AppCapabilityHost({
      appVersion: '2.5.0',
      platform: 'linux',
      runtime: 'server',
      locale: 'en-US',
      arch: 'x64',
    })
    const i18n = new I18nCapabilityHost({ hostLanguage: 'en-US' })
    // Cast: this test only exercises Plan A surfaces; Plan B fields are unused.
    const capHost: CapabilityHost = {
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

    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: WORKER_SCRIPT_PATH,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    const activation = new ActivationDispatcher(registry, host)
    await activation.dispatch({ kind: 'startup' })

    await vi.waitFor(
      () => {
        const tail = log.getTail('test.echo', 10)
        expect(
          tail.find((e) => e.msg === 'echo plugin top-level executed')
        ).toBeTruthy()
      },
      { timeout: 10_000 }
    )

    await host.shutdown()
  }, 15_000) // generous test timeout: WASM + worker boot can be slow on first run
})
