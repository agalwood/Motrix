import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeStubCapabilityHost, spawnTestBridge } from './test-helpers'

describe('QuickJSWorker live locale updates', () => {
  let fixtureDir: string

  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), 'motrix-locale-worker-'))
    mkdirSync(path.join(fixtureDir, 'dist'), { recursive: true })
    writeFileSync(
      path.join(fixtureDir, 'motrix-plugin.json'),
      JSON.stringify({
        manifestVersion: 1,
        id: 'test.locale-live',
        name: 'Locale live test',
        version: '1.0.0',
        description: 'Exercises live locale propagation',
        categories: ['integration'],
        engines: { motrix: '>=2.0.0' },
        main: 'dist/plugin.js',
        permissions: [],
        activationEvents: ['onStartup'],
        contributes: {},
      })
    )
    writeFileSync(
      path.join(fixtureDir, 'dist', 'plugin.js'),
      `
import { app, commands, i18n } from 'motrix:plugin-api'

commands.register('test.locale-live.read', () => ({
  appLocale: app.locale,
  language: i18n.language,
  dir: i18n.dir,
  greeting: i18n.t('greeting'),
  fallback: i18n.t('fallback.only'),
}))
`
    )
  })

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  it('updates dictionaries, language, direction, and app locale in an active VM', async () => {
    const capabilityHost = makeStubCapabilityHost()
    capabilityHost.i18nSnapshot = () => ({
      language: 'en-US',
      dir: 'ltr',
      currentDict: { greeting: 'Hello' },
      fallbackDict: { 'fallback.only': 'Fallback' },
    })

    const spawned = await spawnTestBridge(fixtureDir, {
      capabilityHost,
      timeoutMs: 15_000,
    })

    expect(
      await spawned.callPlugin('test.locale-live.read', undefined)
    ).toEqual({
      appLocale: 'en-US',
      language: 'en-US',
      dir: 'ltr',
      greeting: 'Hello',
      fallback: 'Fallback',
    })

    spawned.bridge.postLocaleChange('ar-EG', 'rtl', {
      greeting: 'مرحبا',
    })

    expect(
      await spawned.callPlugin('test.locale-live.read', undefined)
    ).toEqual({
      appLocale: 'ar-EG',
      language: 'ar-EG',
      dir: 'rtl',
      greeting: 'مرحبا',
      fallback: 'Fallback',
    })

    await spawned.bridge.dispose()
  }, 20_000)

  it('retains a locale event received before the plugin API is injected', async () => {
    const capabilityHost = makeStubCapabilityHost()
    capabilityHost.i18nSnapshot = () => ({
      language: 'en-US',
      dir: 'ltr',
      currentDict: { greeting: 'Hello' },
      fallbackDict: { 'fallback.only': 'Fallback' },
    })

    const spawned = await spawnTestBridge(fixtureDir, {
      capabilityHost,
      timeoutMs: 15_000,
      beforeReady: (bridge) => {
        bridge.postLocaleChange('zh-CN', 'ltr', { greeting: '你好' })
      },
    })

    expect(
      await spawned.callPlugin('test.locale-live.read', undefined)
    ).toEqual({
      appLocale: 'zh-CN',
      language: 'zh-CN',
      dir: 'ltr',
      greeting: '你好',
      fallback: 'Fallback',
    })

    await spawned.bridge.dispose()
  }, 20_000)
})
