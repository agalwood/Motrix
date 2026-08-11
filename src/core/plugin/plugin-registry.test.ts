import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { migrate } from '@core/session/migrations'
import type { SupportedLocale } from '@shared/constants/locales'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginRegistry } from './plugin-registry'
import { PluginStateStore } from './state/plugin-state-store'

const minimalManifest = (id: string) => ({
  manifestVersion: 1,
  id,
  name: `name-${id}`,
  version: '1.0.0',
  description: 'd',
  categories: ['integration'],
  engines: { motrix: '>=2.0.0' },
  main: 'dist/plugin.js',
  permissions: [],
  activationEvents: ['onStartup'],
  contributes: {},
})

describe('PluginRegistry', () => {
  let dir: string
  let store: PluginStateStore
  let reg: PluginRegistry

  function makeRegistry(devPath?: string): PluginRegistry {
    return new PluginRegistry({
      pluginsDir: path.join(dir, 'community'),
      builtinDir: path.join(dir, 'builtin'),
      stateStore: store,
      hostVersion: '2.5.0',
      devPath,
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mreg-'))
    const db = new Database(':memory:')
    migrate(db)
    store = new PluginStateStore(db)
    reg = makeRegistry()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function plant(parent: string, id: string) {
    const dirPath = path.join(parent, id)
    mkdirSync(path.join(dirPath, 'dist'), { recursive: true })
    writeFileSync(
      path.join(dirPath, 'motrix-plugin.json'),
      JSON.stringify(minimalManifest(id))
    )
    writeFileSync(path.join(dirPath, 'dist', 'plugin.js'), 'export default {}')
  }

  it('discovers a community plugin', async () => {
    plant(path.join(dir, 'community'), 'alice.one')
    await reg.discover()
    expect(reg.list().map((p) => p.id)).toEqual(['alice.one'])
  })

  it('applies the host community-directory policy before indexing', async () => {
    plant(path.join(dir, 'community'), 'alice.one')
    const policy = vi.fn(async () => ({
      ok: false,
      reason: 'plugin.lifecycle.install_record_required',
    }))
    const guarded = new PluginRegistry({
      pluginsDir: path.join(dir, 'community'),
      builtinDir: path.join(dir, 'builtin'),
      stateStore: store,
      hostVersion: '2.5.0',
      communityDirectoryPolicy: policy,
    })

    await guarded.discover()

    expect(guarded.list()).toEqual([])
    expect(guarded.loadErrors()).toEqual([
      expect.objectContaining({
        message: 'plugin.lifecycle.install_record_required',
      }),
    ])
    expect(policy).toHaveBeenCalledWith(
      path.join(dir, 'community', 'alice.one')
    )
  })

  it('discover() removes orphan ffmpeg staging dirs before scanning plugins', async () => {
    // Seed an orphan staging dir from a previous (crashed) run.
    const orphanRoot = path.join(dir, 'community', 'alice', 'staging', 't-old')
    mkdirSync(orphanRoot, { recursive: true })
    writeFileSync(path.join(orphanRoot, 'leftover.mp4'), 'crashed bytes')

    // Verify the orphan exists before discover
    expect(existsSync(orphanRoot)).toBe(true)

    await reg.discover()

    // After discover, the staging tree under <pluginId>/staging is gone
    expect(existsSync(orphanRoot)).toBe(false)
  })

  it('discovers built-in and community in the same index', async () => {
    plant(path.join(dir, 'community'), 'alice.one')
    plant(path.join(dir, 'builtin'), 'foo.two')
    await reg.discover()
    expect(
      reg
        .list()
        .map((p) => p.id)
        .sort()
    ).toEqual(['alice.one', 'foo.two'])
  })

  it('records load error for bad manifest but keeps registry intact', async () => {
    const dirPath = path.join(dir, 'community', 'alice.bad')
    mkdirSync(path.join(dirPath, 'dist'), { recursive: true })
    writeFileSync(path.join(dirPath, 'motrix-plugin.json'), '{ broken')
    await reg.discover()
    expect(reg.list().find((p) => p.id === 'alice.bad')).toBeUndefined()
    expect(reg.loadErrors()).toHaveLength(1)
  })

  it('engine version mismatch produces a specific error code', async () => {
    const m = minimalManifest('alice.old')
    m.engines.motrix = '>=99.0.0'
    const dirPath = path.join(dir, 'community', 'alice.old')
    mkdirSync(path.join(dirPath, 'dist'), { recursive: true })
    writeFileSync(path.join(dirPath, 'motrix-plugin.json'), JSON.stringify(m))
    writeFileSync(path.join(dirPath, 'dist', 'plugin.js'), '')
    await reg.discover()
    expect(reg.loadErrors()[0]?.code).toBe('PLUGIN_ENGINE_VERSION_TOO_OLD')
  })

  it('persists state row on first discovery', async () => {
    plant(path.join(dir, 'community'), 'alice.one')
    await reg.discover()
    expect(store.get('alice.one')).toBeDefined()
  })

  it('refreshState syncs in-memory state from stateStore after writes', async () => {
    plant(path.join(dir, 'community'), 'alice.one')
    await reg.discover()
    expect(reg.list().find((p) => p.id === 'alice.one')?.enabled).toBe(true)

    store.setEnabled('alice.one', false)
    // Without refreshState, list() returns the stale in-memory snapshot.
    expect(reg.list().find((p) => p.id === 'alice.one')?.enabled).toBe(true)

    reg.refreshState('alice.one')
    const dto = reg.list().find((p) => p.id === 'alice.one')
    expect(dto?.enabled).toBe(false)
    expect(dto?.status).toBe('disabled')
    expect(reg.get('alice.one')?.state.enabled).toBe(false)
  })

  it('refreshState is a no-op for unknown plugin ids', async () => {
    plant(path.join(dir, 'community'), 'alice.one')
    await reg.discover()
    expect(() => reg.refreshState('does.not.exist')).not.toThrow()
  })

  it('accepts reserved publisher (motrix.*) from builtinDir', async () => {
    plant(path.join(dir, 'builtin'), 'motrix.resolver')
    await reg.discover()
    expect(reg.list().map((p) => p.id)).toEqual(['motrix.resolver'])
    expect(reg.loadErrors()).toHaveLength(0)
  })

  it('rejects reserved publisher (motrix.*) from community pluginsDir', async () => {
    plant(path.join(dir, 'community'), 'motrix.fake')
    await reg.discover()
    expect(reg.list()).toHaveLength(0)
    // PluginRegistry surfaces the ErrorCode enum, while the validationCode
    // ('plugin.manifest.id_reserved_publisher') lives on the AppError subclass.
    expect(reg.loadErrors()[0]?.code).toBe('PLUGIN_MANIFEST_INVALID')
    expect(reg.loadErrors()[0]?.message).toContain('publisher name is reserved')
  })

  // -------------------------------------------------------------------------
  // M7 — MOTRIX_PLUGIN_DEV_PATH bypasses installer / consent (spec §7 L2418)
  // -------------------------------------------------------------------------
  describe('MOTRIX_PLUGIN_DEV_PATH', () => {
    it('indexes a dev plugin and tags its source as type: "dev"', async () => {
      const devDir = path.join(dir, 'dev')
      mkdirSync(path.join(devDir, 'dist'), { recursive: true })
      writeFileSync(
        path.join(devDir, 'motrix-plugin.json'),
        JSON.stringify(minimalManifest('alice.dev'))
      )
      writeFileSync(path.join(devDir, 'dist', 'plugin.js'), 'export default {}')
      reg = makeRegistry(devDir)
      await reg.discover()
      const entry = reg.list().find((p) => p.id === 'alice.dev')
      expect(entry).toBeDefined()
      expect(entry?.source?.type).toBe('dev')
      expect(entry?.source?.url).toBe(devDir)
    })

    it('does not write an _install.json for a dev plugin', async () => {
      const devDir = path.join(dir, 'dev2')
      mkdirSync(path.join(devDir, 'dist'), { recursive: true })
      writeFileSync(
        path.join(devDir, 'motrix-plugin.json'),
        JSON.stringify(minimalManifest('alice.dev2'))
      )
      writeFileSync(path.join(devDir, 'dist', 'plugin.js'), 'export default {}')
      reg = makeRegistry(devDir)
      await reg.discover()
      // Dev path bypasses the installer entirely — registry.discover() reads
      // the manifest directly. The install dir must remain free of host-
      // managed metadata.
      const installDir = path.join(devDir, '_install.json')
      const { existsSync } = await import('node:fs')
      expect(existsSync(installDir)).toBe(false)
    })
  })

  describe('i18n placeholder resolution', () => {
    function plantWithLocale(
      parent: string,
      id: string,
      locales: Record<string, Record<string, string>>
    ): void {
      const dirPath = path.join(parent, id)
      mkdirSync(path.join(dirPath, 'dist'), { recursive: true })
      mkdirSync(path.join(dirPath, 'locales'), { recursive: true })
      const manifest = {
        ...minimalManifest(id),
        name: '%name%',
        description: '%description%',
        l10n: 'locales',
      }
      writeFileSync(
        path.join(dirPath, 'motrix-plugin.json'),
        JSON.stringify(manifest)
      )
      writeFileSync(
        path.join(dirPath, 'dist', 'plugin.js'),
        'export default {}'
      )
      for (const [lang, dict] of Object.entries(locales)) {
        writeFileSync(
          path.join(dirPath, 'locales', `${lang}.json`),
          JSON.stringify(dict)
        )
      }
    }

    it('resolves %name% / %description% from the current locale dict', async () => {
      plantWithLocale(path.join(dir, 'community'), 'alice.locale', {
        'en-US': { name: 'Hello', description: 'A demo plugin' },
        'zh-CN': { name: '你好', description: '示例插件' },
      })
      const r = new PluginRegistry({
        pluginsDir: path.join(dir, 'community'),
        builtinDir: path.join(dir, 'builtin'),
        stateStore: store,
        hostVersion: '2.5.0',
        hostLanguage: 'zh-CN',
      })
      await r.discover()
      const dto = r.list().find((p) => p.id === 'alice.locale')
      expect(dto?.name).toBe('你好')
      expect(dto?.description).toBe('示例插件')
    })

    it('falls back to en-US when the current locale dict is missing', async () => {
      plantWithLocale(path.join(dir, 'community'), 'alice.fallback', {
        'en-US': { name: 'Hello', description: 'A demo plugin' },
      })
      const r = new PluginRegistry({
        pluginsDir: path.join(dir, 'community'),
        builtinDir: path.join(dir, 'builtin'),
        stateStore: store,
        hostVersion: '2.5.0',
        hostLanguage: 'zh-CN',
      })
      await r.discover()
      const dto = r.list().find((p) => p.id === 'alice.fallback')
      expect(dto?.name).toBe('Hello')
    })

    it('leaves %key% intact when no dict provides the key', async () => {
      plantWithLocale(path.join(dir, 'community'), 'alice.nolocale', {})
      await reg.discover()
      const dto = reg.list().find((p) => p.id === 'alice.nolocale')
      // resolveOne returns the original "%name%" when neither dict has the key
      expect(dto?.name).toBe('%name%')
    })

    it('resolves nested dotted-key placeholders from the locale dict', async () => {
      // A locale file with nested objects must flatten to dotted keys so a
      // %group.label% manifest placeholder resolves — previously loadLocale
      // kept only top-level strings, silently dropping nested entries.
      const id = 'alice.nested'
      const dirPath = path.join(dir, 'community', id)
      mkdirSync(path.join(dirPath, 'dist'), { recursive: true })
      mkdirSync(path.join(dirPath, 'locales'), { recursive: true })
      writeFileSync(
        path.join(dirPath, 'motrix-plugin.json'),
        JSON.stringify({
          ...minimalManifest(id),
          name: '%group.label%',
          l10n: 'locales',
        })
      )
      writeFileSync(
        path.join(dirPath, 'dist', 'plugin.js'),
        'export default {}'
      )
      writeFileSync(
        path.join(dirPath, 'locales', 'en-US.json'),
        JSON.stringify({ group: { label: 'Nested Works' } })
      )
      const r = new PluginRegistry({
        pluginsDir: path.join(dir, 'community'),
        builtinDir: path.join(dir, 'builtin'),
        stateStore: store,
        hostVersion: '2.5.0',
        hostLanguage: 'en-US',
      })
      await r.discover()
      const dto = r.list().find((p) => p.id === id)
      expect(dto?.name).toBe('Nested Works')
    })
  })

  describe('setHostLanguage', () => {
    let dir2: string
    let store2: PluginStateStore
    let reg2: PluginRegistry

    beforeEach(() => {
      dir2 = mkdtempSync(path.join(tmpdir(), 'mreg-lang-'))
      const db = new Database(':memory:')
      migrate(db)
      store2 = new PluginStateStore(db)
      reg2 = new PluginRegistry({
        pluginsDir: path.join(dir2, 'community'),
        builtinDir: path.join(dir2, 'builtin'),
        stateStore: store2,
        hostVersion: '2.5.0',
        hostLanguage: 'en-US',
      })
    })

    afterEach(() => {
      rmSync(dir2, { recursive: true, force: true })
    })

    function plantWithLocales(parent: string, id: string) {
      const dirPath = path.join(parent, id)
      mkdirSync(path.join(dirPath, 'dist'), { recursive: true })
      mkdirSync(path.join(dirPath, 'l10n'), { recursive: true })
      writeFileSync(
        path.join(dirPath, 'motrix-plugin.json'),
        JSON.stringify({
          ...minimalManifest(id),
          name: '%name%',
          description: '%desc%',
          l10n: 'l10n',
        })
      )
      writeFileSync(
        path.join(dirPath, 'l10n', 'en-US.json'),
        JSON.stringify({ name: `${id} EN`, desc: 'english desc' })
      )
      writeFileSync(
        path.join(dirPath, 'l10n', 'zh-CN.json'),
        JSON.stringify({ name: `${id} ZH`, desc: 'zh desc' })
      )
    }

    it('re-resolves manifest fields without re-reading manifest JSON', async () => {
      plantWithLocales(path.join(dir2, 'community'), 'alice.demo')
      await reg2.discover()

      expect(reg2.get('alice.demo')?.manifest.name).toBe('alice.demo EN')
      expect(reg2.getLocaleDictionaries('alice.demo')).toEqual({
        currentDict: { name: 'alice.demo EN', desc: 'english desc' },
        fallbackDict: { name: 'alice.demo EN', desc: 'english desc' },
      })
      await reg2.setHostLanguage('zh-CN')
      expect(reg2.get('alice.demo')?.manifest.name).toBe('alice.demo ZH')
      expect(reg2.get('alice.demo')?.manifest.description).toBe('zh desc')
      expect(reg2.getLocaleDictionaries('alice.demo')).toEqual({
        currentDict: { name: 'alice.demo ZH', desc: 'zh desc' },
        fallbackDict: { name: 'alice.demo EN', desc: 'english desc' },
      })
    })

    it('keeps manifestRaw unchanged across language switches', async () => {
      plantWithLocales(path.join(dir2, 'community'), 'alice.demo')
      await reg2.discover()
      const rawBefore = reg2.get('alice.demo')?.manifestRaw
      await reg2.setHostLanguage('zh-CN')
      expect(reg2.get('alice.demo')?.manifestRaw).toBe(rawBefore)
      expect(rawBefore?.name).toBe('%name%')
    })

    it('is a no-op when called with the current language', async () => {
      plantWithLocales(path.join(dir2, 'community'), 'alice.demo')
      await reg2.discover()
      const resolvedBefore = reg2.get('alice.demo')?.manifest
      await reg2.setHostLanguage('en-US')
      expect(reg2.get('alice.demo')?.manifest).toBe(resolvedBefore)
    })

    it('falls back to en-US when the new locale file is missing', async () => {
      plantWithLocales(path.join(dir2, 'community'), 'alice.demo')
      rmSync(path.join(dir2, 'community', 'alice.demo', 'l10n', 'zh-CN.json'))
      await reg2.discover()
      await reg2.setHostLanguage('zh-CN')
      expect(reg2.get('alice.demo')?.manifest.name).toBe('alice.demo EN')
      expect(reg2.getLocaleDictionaries('alice.demo')).toEqual({
        currentDict: {},
        fallbackDict: { name: 'alice.demo EN', desc: 'english desc' },
      })
    })

    it('keeps activation snapshots wholly old until one synchronous commit', async () => {
      plantWithLocales(path.join(dir2, 'community'), 'alice.demo')
      plantWithLocales(path.join(dir2, 'community'), 'bob.demo')
      let releaseBob: (() => void) | undefined
      let markBobStarted: (() => void) | undefined
      let markAlicePrepared: (() => void) | undefined
      const bobBlocked = new Promise<void>((resolve) => {
        releaseBob = resolve
      })
      const bobStarted = new Promise<void>((resolve) => {
        markBobStarted = resolve
      })
      const alicePrepared = new Promise<void>((resolve) => {
        markAlicePrepared = resolve
      })
      let blockSwitch = false
      const transactionRegistry = new PluginRegistry({
        pluginsDir: path.join(dir2, 'community'),
        builtinDir: path.join(dir2, 'builtin'),
        stateStore: store2,
        hostVersion: '2.5.0',
        hostLanguage: 'en-US',
        readLocaleFile: async (filePath) => {
          const contents = await readFile(filePath, 'utf8')
          if (
            blockSwitch &&
            filePath.endsWith(path.join('alice.demo', 'l10n', 'zh-CN.json'))
          ) {
            markAlicePrepared?.()
          }
          if (
            blockSwitch &&
            filePath.endsWith(path.join('bob.demo', 'l10n', 'zh-CN.json'))
          ) {
            markBobStarted?.()
            await bobBlocked
          }
          return contents
        },
      })
      await transactionRegistry.discover()
      blockSwitch = true
      let capabilityLanguage: SupportedLocale = 'en-US'
      const activationSnapshot = (pluginId: string) => ({
        language: capabilityLanguage,
        name: transactionRegistry.get(pluginId)?.manifest.name,
        currentDict:
          transactionRegistry.getLocaleDictionaries(pluginId).currentDict,
      })
      let synchronousCommitSnapshot:
        | ReturnType<typeof activationSnapshot>
        | undefined

      const switching = transactionRegistry.setHostLanguageTransaction(
        'zh-CN',
        {
          commitHostLocale: () => {
            capabilityLanguage = 'zh-CN'
            synchronousCommitSnapshot = activationSnapshot('alice.demo')
          },
          rollbackHostLocale: (previousLanguage) => {
            capabilityLanguage = previousLanguage
          },
        }
      )
      await Promise.all([alicePrepared, bobStarted])

      expect(activationSnapshot('alice.demo')).toEqual({
        language: 'en-US',
        name: 'alice.demo EN',
        currentDict: { name: 'alice.demo EN', desc: 'english desc' },
      })
      expect(activationSnapshot('bob.demo')).toEqual({
        language: 'en-US',
        name: 'bob.demo EN',
        currentDict: { name: 'bob.demo EN', desc: 'english desc' },
      })

      releaseBob?.()
      await switching

      expect(activationSnapshot('alice.demo')).toEqual({
        language: 'zh-CN',
        name: 'alice.demo ZH',
        currentDict: { name: 'alice.demo ZH', desc: 'zh desc' },
      })
      expect(activationSnapshot('bob.demo')).toEqual({
        language: 'zh-CN',
        name: 'bob.demo ZH',
        currentDict: { name: 'bob.demo ZH', desc: 'zh desc' },
      })
      expect(synchronousCommitSnapshot).toEqual({
        language: 'zh-CN',
        name: 'alice.demo ZH',
        currentDict: { name: 'alice.demo ZH', desc: 'zh desc' },
      })
    })

    it('does not commit or broadcast a locale that became stale during prepare', async () => {
      plantWithLocales(path.join(dir2, 'community'), 'alice.demo')
      let releasePrepare: (() => void) | undefined
      let markPrepareStarted: (() => void) | undefined
      const prepareBlocked = new Promise<void>((resolve) => {
        releasePrepare = resolve
      })
      const prepareStarted = new Promise<void>((resolve) => {
        markPrepareStarted = resolve
      })
      let blockSwitch = false
      const transactionRegistry = new PluginRegistry({
        pluginsDir: path.join(dir2, 'community'),
        builtinDir: path.join(dir2, 'builtin'),
        stateStore: store2,
        hostVersion: '2.5.0',
        hostLanguage: 'en-US',
        readLocaleFile: async (filePath) => {
          const contents = await readFile(filePath, 'utf8')
          if (
            blockSwitch &&
            filePath.endsWith(path.join('l10n', 'zh-CN.json'))
          ) {
            markPrepareStarted?.()
            await prepareBlocked
          }
          return contents
        },
      })
      await transactionRegistry.discover()
      blockSwitch = true
      let current = true
      let capabilityLanguage: SupportedLocale = 'en-US'
      const beforeCommit = vi.fn()

      const switching = transactionRegistry.setHostLanguageTransaction(
        'zh-CN',
        {
          beforeCommit,
          commitHostLocale: () => {
            capabilityLanguage = 'zh-CN'
          },
          rollbackHostLocale: (previousLanguage) => {
            capabilityLanguage = previousLanguage
          },
          shouldCommit: () => current,
        }
      )
      await prepareStarted
      current = false
      releasePrepare?.()

      await expect(switching).resolves.toBe(false)
      expect(beforeCommit).not.toHaveBeenCalled()
      expect(capabilityLanguage).toBe('en-US')
      expect(transactionRegistry.get('alice.demo')?.manifest.name).toBe(
        'alice.demo EN'
      )
      expect(
        transactionRegistry.getLocaleDictionaries('alice.demo').currentDict
      ).toEqual({ name: 'alice.demo EN', desc: 'english desc' })
    })

    it('rolls back every published target when the commit callback throws', async () => {
      plantWithLocales(path.join(dir2, 'community'), 'alice.demo')
      await reg2.discover()
      let mainLanguage: SupportedLocale = 'en-US'
      let capabilityLanguage: SupportedLocale = 'en-US'
      const rollbackHostLocale = vi.fn((previousLanguage: SupportedLocale) => {
        mainLanguage = previousLanguage
        capabilityLanguage = previousLanguage
      })

      await expect(
        reg2.setHostLanguageTransaction('zh-CN', {
          beforeCommit: () => {
            mainLanguage = 'zh-CN'
          },
          commitHostLocale: () => {
            capabilityLanguage = 'zh-CN'
            throw new Error('capability publication failed')
          },
          rollbackHostLocale,
        })
      ).rejects.toThrow('capability publication failed')

      expect(rollbackHostLocale).toHaveBeenCalledWith('en-US')
      expect(mainLanguage).toBe('en-US')
      expect(capabilityLanguage).toBe('en-US')
      expect(reg2.get('alice.demo')?.manifest.name).toBe('alice.demo EN')
      expect(reg2.getLocaleDictionaries('alice.demo')).toEqual({
        currentDict: { name: 'alice.demo EN', desc: 'english desc' },
        fallbackDict: { name: 'alice.demo EN', desc: 'english desc' },
      })
    })
  })

  describe('MOTRIX_PLUGIN_DEV_PATH', () => {
    it('adds a dev plugin from the env-var path', async () => {
      const devDir = path.join(dir, 'dev-plugin')
      mkdirSync(path.join(devDir, 'dist'), { recursive: true })
      writeFileSync(
        path.join(devDir, 'motrix-plugin.json'),
        JSON.stringify(minimalManifest('dev.plugin'))
      )
      writeFileSync(path.join(devDir, 'dist', 'plugin.js'), 'export default {}')
      reg = makeRegistry(devDir)
      await reg.discover()
      expect(reg.list().map((p) => p.id)).toContain('dev.plugin')
    })

    it('dev plugin rootDir is the devPath directory', async () => {
      const devDir = path.join(dir, 'dev-plugin')
      mkdirSync(path.join(devDir, 'dist'), { recursive: true })
      writeFileSync(
        path.join(devDir, 'motrix-plugin.json'),
        JSON.stringify(minimalManifest('dev.plugin'))
      )
      writeFileSync(path.join(devDir, 'dist', 'plugin.js'), 'export default {}')
      reg = makeRegistry(devDir)
      await reg.discover()
      const indexed = reg.get('dev.plugin')
      expect(indexed?.rootDir).toBe(devDir)
      expect(indexed?.origin).toBe('community')
    })

    it('silently skips dev path if manifest is missing', async () => {
      reg = makeRegistry(path.join(dir, 'nonexistent'))
      await reg.discover()
      expect(reg.list()).toHaveLength(0)
      expect(reg.loadErrors()).toHaveLength(0)
    })

    it('silently skips dev path when motrix-plugin.json is malformed', async () => {
      const devDir = path.join(dir, 'dev-bad')
      mkdirSync(devDir, { recursive: true })
      writeFileSync(path.join(devDir, 'motrix-plugin.json'), '{ broken json')
      reg = makeRegistry(devDir)
      await reg.discover()
      expect(reg.list()).toHaveLength(0)
      // Dev-path failures are logged, not pushed to loadErrors().
      expect(reg.loadErrors()).toHaveLength(0)
    })

    it('dev plugin coexists with regular community plugins', async () => {
      plant(path.join(dir, 'community'), 'alice.one')
      const devDir = path.join(dir, 'dev-plugin')
      mkdirSync(path.join(devDir, 'dist'), { recursive: true })
      writeFileSync(
        path.join(devDir, 'motrix-plugin.json'),
        JSON.stringify(minimalManifest('dev.plugin'))
      )
      writeFileSync(path.join(devDir, 'dist', 'plugin.js'), 'export default {}')
      reg = makeRegistry(devDir)
      await reg.discover()
      expect(
        reg
          .list()
          .map((p) => p.id)
          .sort()
      ).toEqual(['alice.one', 'dev.plugin'])
    })
  })
})
