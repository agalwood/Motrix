import type { AppSettings, DashboardTileLayout } from '@shared/types/settings'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_SETTINGS_VERSION } from './migrations'
import { SettingsManager } from './settings-manager'
import {
  DASHBOARD_COLUMNS,
  DEFAULT_APP_SETTINGS,
  DEFAULT_DASHBOARD_LAYOUT,
  DEFAULT_ENGINE_SETTINGS,
  DEFAULT_ONBOARDING_STATE,
  dashboardLayoutSettingsSchema,
} from './validators'

const { mockReadFile, mockWriteFile, mockMkdir, mockWriteFileAtomic } =
  vi.hoisted(() => ({
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockMkdir: vi.fn(),
    mockWriteFileAtomic: vi.fn(),
  }))

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
  },
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}))

// Atomic save lives in write-file-atomic now. Existing tests assert
// "writeFile was called" semantics; the mock keeps the same shape so
// those assertions only need their identifier renamed.
vi.mock('write-file-atomic', () => ({
  default: mockWriteFileAtomic,
}))

const TEST_PATH = '/tmp/test-settings.json'

const mockedFs = {
  readFile: mockReadFile,
  // `writeFile` references in test bodies actually mean "the durable
  // write call SettingsManager makes when persisting". Point them at
  // the writeFileAtomic mock so the existing assertions still match.
  writeFile: mockWriteFileAtomic,
  mkdir: mockMkdir,
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('SettingsManager', () => {
  let manager: SettingsManager
  const onChange = vi.fn<(old: AppSettings, updated: AppSettings) => void>()

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new SettingsManager(TEST_PATH, { onChange })
  })

  describe('load', () => {
    it('uses defaults when file does not exist', async () => {
      mockedFs.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      await manager.load()

      const settings = manager.get()
      expect(settings.version).toBe(CURRENT_SETTINGS_VERSION)
      expect(settings.engine).toEqual(
        expect.objectContaining({
          ...DEFAULT_ENGINE_SETTINGS,
          rpcSecret: expect.any(String),
        })
      )
      expect(settings.engine.rpcSecret).not.toBe('')
      expect(settings.engine.rpcSecret.length).toBeGreaterThanOrEqual(8)
      expect(settings.app).toEqual({
        ...DEFAULT_APP_SETTINGS,
        defaultSaveDir: expect.stringMatching(/Downloads$/),
      })
      expect(settings.app.defaultSaveDir).not.toBe('')
      expect(settings.app.liquidGlassEffect).toBe(false)
      expect(settings.onboarding).toEqual(DEFAULT_ONBOARDING_STATE)
      expect(settings.dashboard).toEqual(DEFAULT_DASHBOARD_LAYOUT)
      expect(settings.dashboard.columns).toBe(DASHBOARD_COLUMNS)
      expect(settings.bridge.fixedPort).toBe('auto')
      expect(settings.bridge.instanceId).toEqual(
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        )
      )
    })

    it('uses an injected Liquid Glass default when the file does not exist', async () => {
      manager = new SettingsManager(TEST_PATH, {
        liquidGlassEffectDefault: true,
      })
      mockedFs.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      await manager.load()

      expect(manager.getApp().liquidGlassEffect).toBe(true)
    })

    it('applies an environment-specific Liquid Glass default when the field is missing', async () => {
      manager = new SettingsManager(TEST_PATH, {
        liquidGlassEffectDefault: true,
      })
      const app = {
        ...DEFAULT_APP_SETTINGS,
        defaultSaveDir: '/downloads',
      } as Partial<typeof DEFAULT_APP_SETTINGS>
      delete app.liquidGlassEffect
      mockedFs.readFile.mockResolvedValue(
        JSON.stringify({
          version: CURRENT_SETTINGS_VERSION,
          engine: { ...DEFAULT_ENGINE_SETTINGS, rpcSecret: 'saved-secret' },
          app,
          plugins: {},
        })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      await manager.load()

      expect(manager.getApp().liquidGlassEffect).toBe(true)
      expect(mockedFs.writeFile).not.toHaveBeenCalled()
    })

    it('recovers when the settings root is valid JSON but not an object', async () => {
      mockedFs.readFile.mockResolvedValue('null')
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      await manager.load()

      expect(manager.get().version).toBe(CURRENT_SETTINGS_VERSION)
      expect(manager.get().onboarding.disclaimerAccepted).toBe(false)
      expect(mockedFs.writeFile).toHaveBeenCalledOnce()
    })

    it.each([
      { persisted: false, injected: true },
      { persisted: true, injected: false },
    ])(
      'preserves a persisted Liquid Glass value of $persisted when the injected default is $injected',
      async ({ persisted, injected }) => {
        manager = new SettingsManager(TEST_PATH, {
          liquidGlassEffectDefault: injected,
        })
        mockedFs.readFile.mockResolvedValue(
          JSON.stringify({
            version: CURRENT_SETTINGS_VERSION,
            engine: { ...DEFAULT_ENGINE_SETTINGS, rpcSecret: 'saved-secret' },
            app: {
              ...DEFAULT_APP_SETTINGS,
              defaultSaveDir: '/downloads',
              liquidGlassEffect: persisted,
            },
            plugins: {},
          })
        )

        await manager.load()

        expect(manager.getApp().liquidGlassEffect).toBe(persisted)
        expect(mockedFs.writeFile).not.toHaveBeenCalled()
      }
    )

    it('seeds an injected platform default only when the sentinel is empty', async () => {
      manager = new SettingsManager(TEST_PATH, {
        defaultSaveDir: '/home/user/Downloads',
      })
      mockedFs.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      await manager.load()

      expect(manager.getApp().defaultSaveDir).toBe('/home/user/Downloads')
    })

    it('migrates only a platform-recognized legacy default directory', async () => {
      const legacyDefault = '/home/user/snap/motrix/123/Downloads'
      manager = new SettingsManager(TEST_PATH, {
        defaultSaveDir: '/home/user/Downloads',
        isLegacyDefaultSaveDir: (value) => value === legacyDefault,
      })
      mockedFs.readFile.mockResolvedValue(
        JSON.stringify({
          version: CURRENT_SETTINGS_VERSION,
          engine: DEFAULT_ENGINE_SETTINGS,
          app: {
            ...DEFAULT_APP_SETTINGS,
            defaultSaveDir: legacyDefault,
          },
          plugins: {},
        })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      await manager.load()

      expect(manager.getApp().defaultSaveDir).toBe('/home/user/Downloads')
      expect(mockedFs.writeFile).toHaveBeenCalled()
    })

    it('preserves a user-selected directory when migrating defaults', async () => {
      manager = new SettingsManager(TEST_PATH, {
        defaultSaveDir: '/home/user/Downloads',
        isLegacyDefaultSaveDir: (value) =>
          value === '/home/user/snap/motrix/123/Downloads',
      })
      mockedFs.readFile.mockResolvedValue(
        JSON.stringify({
          version: CURRENT_SETTINGS_VERSION,
          engine: DEFAULT_ENGINE_SETTINGS,
          app: {
            ...DEFAULT_APP_SETTINGS,
            defaultSaveDir: '/mnt/downloads',
          },
          plugins: {},
        })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      await manager.load()

      expect(manager.getApp().defaultSaveDir).toBe('/mnt/downloads')
    })

    it('does not share dashboard default tile references on missing file load', async () => {
      mockedFs.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      await manager.load()

      manager.get().dashboard.tiles[0].enabled = false

      expect(DEFAULT_DASHBOARD_LAYOUT.tiles[0].enabled).toBe(true)
      expect(dashboardLayoutSettingsSchema.parse({}).tiles[0].enabled).toBe(
        true
      )
    })

    it('loads and validates existing settings', async () => {
      const saved = {
        version: CURRENT_SETTINGS_VERSION,
        engine: { ...DEFAULT_ENGINE_SETTINGS, rpcPort: 6800 },
        app: { ...DEFAULT_APP_SETTINGS, theme: 'dark' },
        onboarding: { disclaimerAccepted: true },
        plugins: {},
      }
      mockedFs.readFile.mockResolvedValue(JSON.stringify(saved))

      await manager.load()

      expect(manager.getEngine().rpcPort).toBe(6800)
      expect(manager.getApp().theme).toBe('dark')
      expect(manager.get().onboarding.disclaimerAccepted).toBe(true)
      expect(manager.get().dashboard).toEqual(DEFAULT_DASHBOARD_LAYOUT)
    })

    it('migrates legacy format on load', async () => {
      const legacy = {
        general: { launchAtStartup: true, restoreOnCrash: true },
        download: {
          defaultSaveDir: '/home/user/dl',
          maxConcurrentTasks: 10,
          maxDownloadSpeed: 0,
          maxUploadSpeed: 0,
        },
        plugins: {},
      }
      mockedFs.readFile.mockResolvedValue(JSON.stringify(legacy))
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      await manager.load()

      expect(manager.get().version).toBe(CURRENT_SETTINGS_VERSION)
      expect(manager.getApp().launchAtStartup).toBe(true)
      expect(manager.getApp().defaultSaveDir).toBe('/home/user/dl')
      expect(manager.getEngine().maxConcurrentDownloads).toBe(10)
      expect(manager.get().dashboard).toEqual(DEFAULT_DASHBOARD_LAYOUT)
    })

    it('falls back to defaults on corrupted JSON', async () => {
      mockedFs.readFile.mockResolvedValue('not valid json {{{')
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      await manager.load()

      const settings = manager.get()
      expect(settings.version).toBe(CURRENT_SETTINGS_VERSION)
      expect(settings.engine).toEqual(
        expect.objectContaining({
          ...DEFAULT_ENGINE_SETTINGS,
          rpcSecret: expect.any(String),
        })
      )
      expect(settings.engine.rpcSecret).not.toBe('')
      expect(settings.engine.rpcSecret.length).toBeGreaterThanOrEqual(8)
      expect(settings.app).toEqual({
        ...DEFAULT_APP_SETTINGS,
        defaultSaveDir: expect.stringMatching(/Downloads$/),
      })
      expect(settings.app.defaultSaveDir).not.toBe('')
    })
  })

  describe('bridge settings', () => {
    it('mints a different instanceId per fresh install', async () => {
      mockedFs.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      const first = new SettingsManager(TEST_PATH, { onChange })
      await first.load()
      const second = new SettingsManager(TEST_PATH, { onChange })
      await second.load()

      expect(first.get().bridge.instanceId).not.toBe('')
      expect(second.get().bridge.instanceId).not.toBe('')
      expect(first.get().bridge.instanceId).not.toBe(
        second.get().bridge.instanceId
      )
    })

    it('preserves a persisted instanceId across reload instead of regenerating it', async () => {
      const saved = {
        version: CURRENT_SETTINGS_VERSION,
        engine: DEFAULT_ENGINE_SETTINGS,
        app: DEFAULT_APP_SETTINGS,
        plugins: {},
        bridge: { fixedPort: 16804, instanceId: 'stable-instance-id' },
      }
      mockedFs.readFile.mockResolvedValue(JSON.stringify(saved))

      await manager.load()

      expect(manager.get().bridge).toEqual({
        fixedPort: 16804,
        instanceId: 'stable-instance-id',
      })
    })

    it('seeds bridge settings when migrating a pre-v9 settings file', async () => {
      const v8 = {
        version: 8,
        engine: DEFAULT_ENGINE_SETTINGS,
        app: DEFAULT_APP_SETTINGS,
        plugins: {},
      }
      mockedFs.readFile.mockResolvedValue(JSON.stringify(v8))
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      await manager.load()

      expect(manager.get().version).toBe(CURRENT_SETTINGS_VERSION)
      expect(manager.get().bridge.fixedPort).toBe('auto')
      expect(manager.get().bridge.instanceId).toEqual(
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        )
      )
    })
  })

  describe('get / getEngine / getApp', () => {
    beforeEach(async () => {
      mockedFs.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)
      await manager.load()
    })

    it('get() returns full settings', () => {
      const settings = manager.get()
      expect(settings).toHaveProperty('version')
      expect(settings).toHaveProperty('engine')
      expect(settings).toHaveProperty('app')
      expect(settings).toHaveProperty('onboarding')
      expect(settings).toHaveProperty('plugins')
    })

    it('getEngine() returns engine settings', () => {
      const engine = manager.getEngine()
      expect(engine).toEqual(
        expect.objectContaining({
          ...DEFAULT_ENGINE_SETTINGS,
          rpcSecret: expect.any(String),
        })
      )
      expect(engine.rpcSecret).not.toBe('')
      expect(engine.rpcSecret.length).toBeGreaterThanOrEqual(8)
    })

    it('getApp() returns app settings', () => {
      expect(manager.getApp()).toEqual({
        ...DEFAULT_APP_SETTINGS,
        defaultSaveDir: expect.stringMatching(/Downloads$/),
      })
      expect(manager.getApp().defaultSaveDir).not.toBe('')
    })
  })

  describe('update', () => {
    beforeEach(async () => {
      mockedFs.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)
      await manager.load()
    })

    it('updates engine settings and persists', async () => {
      const result = await manager.update({
        engine: { maxConcurrentDownloads: 10 },
      })

      expect(result.saved).toBe(true)
      expect(result.requiresRestart).toBe(false)
      expect(manager.getEngine().maxConcurrentDownloads).toBe(10)
      expect(mockedFs.writeFile).toHaveBeenCalled()
    })

    it('persists explicit split and disk tuning values unchanged', async () => {
      await manager.update({
        engine: {
          split: 32,
          fileAllocation: 'prealloc',
          diskCache: 32 * 1024 * 1024,
        },
      })

      expect(manager.getEngine()).toEqual(
        expect.objectContaining({
          performanceProfile: 'custom',
          split: 32,
          fileAllocation: 'prealloc',
          diskCache: 32 * 1024 * 1024,
        })
      )
      const persisted = JSON.parse(
        mockedFs.writeFile.mock.calls.at(-1)?.[1] as string
      ) as AppSettings
      expect(persisted.engine).toEqual(
        expect.objectContaining({
          performanceProfile: 'custom',
          split: 32,
          fileAllocation: 'prealloc',
          diskCache: 32 * 1024 * 1024,
        })
      )
    })

    it('applies every linked value when selecting a performance profile', async () => {
      const result = await manager.update({
        engine: { performanceProfile: 'high' },
      })

      expect(manager.getEngine()).toEqual(
        expect.objectContaining({
          performanceProfile: 'high',
          maxConnectionPerServer: 32,
          split: 32,
          minSplitSize: 4 * 1024 * 1024,
          diskCache: 64 * 1024 * 1024,
        })
      )
      expect(result.requiresRestart).toBe(true)
      expect(result.changedRestartKeys).toContain('diskCache')
    })

    it('updates app settings and persists', async () => {
      const before = manager.get()
      const result = await manager.update({
        app: { theme: 'dark' },
      })

      expect(result.saved).toBe(true)
      expect(result.requiresRestart).toBe(false)
      expect(manager.getApp().theme).toBe('dark')
      expect(before.app.theme).toBe(DEFAULT_APP_SETTINGS.theme)
      expect(manager.get()).not.toBe(before)
    })

    it('persists disclaimer consent transactionally', async () => {
      const result = await manager.acceptDisclaimer()

      expect(result.saved).toBe(true)
      expect(result.requiresRestart).toBe(false)
      expect(result.requiresAppRestart).toBe(false)
      expect(manager.get().onboarding).toEqual({ disclaimerAccepted: true })

      const writtenJson = mockedFs.writeFile.mock.calls.at(-1)?.[1] as string
      expect(JSON.parse(writtenJson).onboarding).toEqual({
        disclaimerAccepted: true,
      })
    })

    it('does not leak failed consent into a later settings save', async () => {
      mockedFs.writeFile.mockRejectedValueOnce(new Error('disk full'))

      await expect(manager.acceptDisclaimer()).rejects.toThrow('disk full')
      expect(manager.get().onboarding.disclaimerAccepted).toBe(false)

      mockedFs.writeFile.mockResolvedValue(undefined)
      await manager.update({ app: { language: 'zh-CN' } })

      const writtenJson = mockedFs.writeFile.mock.calls.at(-1)?.[1] as string
      expect(JSON.parse(writtenJson).onboarding).toEqual({
        disclaimerAccepted: false,
      })
    })

    it('serializes acceptance with a concurrent disclaimer language save', async () => {
      mockedFs.writeFile.mockClear()

      await Promise.all([
        manager.acceptDisclaimer(),
        manager.setDisclaimerLanguage('zh-CN'),
      ])

      const writtenJson = mockedFs.writeFile.mock.calls.at(-1)?.[1] as string
      const persisted = JSON.parse(writtenJson) as AppSettings
      expect(persisted.onboarding.disclaimerAccepted).toBe(true)
      expect(persisted.app.language).toBe('zh-CN')
      expect(manager.get().onboarding.disclaimerAccepted).toBe(true)
      expect(manager.getApp().language).toBe('zh-CN')
    })

    it('serializes update with disclaimer language and commits in write order', async () => {
      mockedFs.writeFile.mockClear()
      const firstWriteStarted = deferred()
      const releaseFirstWrite = deferred()
      const secondWriteStarted = deferred()
      const releaseSecondWrite = deferred()
      mockedFs.writeFile
        .mockImplementationOnce(async () => {
          firstWriteStarted.resolve()
          await releaseFirstWrite.promise
        })
        .mockImplementationOnce(async () => {
          secondWriteStarted.resolve()
          await releaseSecondWrite.promise
        })

      const first = manager.update({
        app: { language: 'zh-CN', theme: 'dark' },
      })
      const second = manager.setDisclaimerLanguage('en-US')

      await firstWriteStarted.promise
      expect(mockedFs.writeFile).toHaveBeenCalledOnce()
      expect(manager.getApp().language).toBe('en-US')
      expect(manager.getApp().theme).toBe(DEFAULT_APP_SETTINGS.theme)
      expect(onChange).not.toHaveBeenCalled()

      releaseFirstWrite.resolve()
      await first
      await secondWriteStarted.promise

      expect(mockedFs.writeFile).toHaveBeenCalledTimes(2)
      expect(manager.getApp().language).toBe('zh-CN')
      expect(manager.getApp().theme).toBe('dark')

      const firstPersisted = JSON.parse(
        mockedFs.writeFile.mock.calls[0]?.[1] as string
      ) as AppSettings
      const secondPersisted = JSON.parse(
        mockedFs.writeFile.mock.calls[1]?.[1] as string
      ) as AppSettings
      expect(firstPersisted.app).toEqual(
        expect.objectContaining({ language: 'zh-CN', theme: 'dark' })
      )
      expect(secondPersisted.app).toEqual(
        expect.objectContaining({ language: 'en-US', theme: 'dark' })
      )

      releaseSecondWrite.resolve()
      await second

      expect(manager.getApp()).toEqual(
        expect.objectContaining({ language: 'en-US', theme: 'dark' })
      )
      expect(
        onChange.mock.calls.map(([old, updated]) => [
          old.app.language,
          updated.app.language,
        ])
      ).toEqual([
        ['en-US', 'zh-CN'],
        ['zh-CN', 'en-US'],
      ])
    })

    it('keeps memory and events unchanged when an update write fails', async () => {
      mockedFs.writeFile.mockRejectedValueOnce(new Error('disk full'))

      await expect(
        manager.update({ app: { language: 'zh-CN', theme: 'dark' } })
      ).rejects.toThrow('disk full')

      expect(manager.getApp().language).toBe('en-US')
      expect(manager.getApp().theme).toBe(DEFAULT_APP_SETTINGS.theme)
      expect(onChange).not.toHaveBeenCalled()

      mockedFs.writeFile.mockResolvedValue(undefined)
      await manager.setDisclaimerLanguage('zh-CN')

      const persisted = JSON.parse(
        mockedFs.writeFile.mock.calls.at(-1)?.[1] as string
      ) as AppSettings
      expect(persisted.app.language).toBe('zh-CN')
      expect(persisted.app.theme).toBe(DEFAULT_APP_SETTINGS.theme)
      expect(manager.getApp()).toEqual(
        expect.objectContaining({
          language: 'zh-CN',
          theme: DEFAULT_APP_SETTINGS.theme,
        })
      )
      expect(onChange).toHaveBeenCalledOnce()
    })

    it('returns without writing when disclaimer consent already exists', async () => {
      await manager.acceptDisclaimer()
      mockedFs.writeFile.mockClear()

      const result = await manager.acceptDisclaimer()

      expect(manager.get().onboarding.disclaimerAccepted).toBe(true)
      expect(result.saved).toBe(false)
      expect(mockedFs.writeFile).not.toHaveBeenCalled()
    })

    it('detects restart-required keys', async () => {
      const result = await manager.update({
        engine: { rpcPort: 6800 },
      })

      expect(result.saved).toBe(true)
      expect(result.requiresRestart).toBe(true)
      expect(result.changedRestartKeys).toContain('rpcPort')
    })

    it('detects multiple restart-required keys', async () => {
      const result = await manager.update({
        engine: { rpcPort: 6800, rpcSecret: 'new-secret' },
      })

      expect(result.requiresRestart).toBe(true)
      expect(result.changedRestartKeys).toContain('rpcPort')
      expect(result.changedRestartKeys).toContain('rpcSecret')
    })

    it('persists an explicit empty RPC secret and requires an engine restart', async () => {
      const result = await manager.update({ engine: { rpcSecret: '' } })

      expect(result.requiresRestart).toBe(true)
      expect(result.changedRestartKeys).toContain('rpcSecret')
      expect(manager.getEngine().rpcSecret).toBe('')

      const persisted = JSON.parse(
        mockedFs.writeFile.mock.calls.at(-1)?.[1] as string
      ) as AppSettings
      expect(persisted.engine.rpcSecret).toBe('')

      mockedFs.writeFile.mockClear()
      mockedFs.readFile.mockResolvedValue(JSON.stringify(persisted))
      const reloaded = new SettingsManager(TEST_PATH)
      await reloaded.load()

      expect(reloaded.getEngine().rpcSecret).toBe('')
      expect(mockedFs.writeFile).not.toHaveBeenCalled()
    })

    it.each([123, null, undefined])(
      'rejects a non-string RPC secret update without changing state',
      async (invalidSecret) => {
        const currentRpcSecret = manager.getEngine().rpcSecret
        mockedFs.writeFile.mockClear()

        await expect(
          manager.update({
            engine: {
              rpcSecret: invalidSecret as unknown as string,
            },
          })
        ).rejects.toThrow(
          'settings.engine.rpcSecret must be a string when provided'
        )

        expect(manager.getEngine().rpcSecret).toBe(currentRpcSecret)
        expect(mockedFs.writeFile).not.toHaveBeenCalled()
        expect(onChange).not.toHaveBeenCalled()
      }
    )

    it('requires an engine restart when the session save interval changes', async () => {
      const result = await manager.update({
        engine: { sessionSaveInterval: 30 },
      })

      expect(result.requiresRestart).toBe(true)
      expect(result.changedRestartKeys).toContain('sessionSaveInterval')
    })

    it('does not flag restart for non-restart keys', async () => {
      await manager.update({ engine: { performanceProfile: 'custom' } })
      const result = await manager.update({
        engine: { split: 10, maxConcurrentDownloads: 8 },
      })

      expect(result.requiresRestart).toBe(false)
      expect(result.changedRestartKeys).toHaveLength(0)
    })

    it('validates updated engine settings', async () => {
      await manager.update({
        engine: { rpcPort: 80 },
      })

      // Invalid port reverts to default
      expect(manager.getEngine().rpcPort).toBe(DEFAULT_ENGINE_SETTINGS.rpcPort)
    })

    it('validates updated app settings', async () => {
      await manager.update({
        app: { theme: 'neon' as 'system' | 'light' | 'dark' },
      })

      // Invalid theme reverts to default
      expect(manager.getApp().theme).toBe(DEFAULT_APP_SETTINGS.theme)
    })

    it('merges nat namespace on partial update', async () => {
      const result = await manager.update({ nat: { enabled: false } })
      expect(result.saved).toBe(true)
      expect(manager.get().nat.enabled).toBe(false)
      // Untouched fields should retain defaults
      expect(manager.get().nat.preferredProtocol).toBe('auto')
    })

    it('merges proxy namespace on partial update', async () => {
      const result = await manager.update({
        proxy: { enabled: true, host: '127.0.0.1', port: 1080 },
      })
      expect(result.saved).toBe(true)
      expect(manager.getProxy().enabled).toBe(true)
      expect(manager.getProxy().host).toBe('127.0.0.1')
      expect(manager.getProxy().port).toBe(1080)
    })

    it('deep-merges proxy.scopes so a partial scope patch keeps siblings', async () => {
      await manager.update({ proxy: { scopes: { updateApp: true } } })
      await manager.update({ proxy: { scopes: { download: true } } })
      const scopes = manager.getProxy().scopes
      expect(scopes.download).toBe(true)
      // Must NOT be wiped by the second partial scopes patch.
      expect(scopes.updateApp).toBe(true)
    })

    it('merges bridge namespace on partial update', async () => {
      const result = await manager.update({ bridge: { fixedPort: 16900 } })
      expect(result.saved).toBe(true)
      expect(manager.get().bridge.fixedPort).toBe(16900)
    })

    it('does not reset instanceId to the unseeded sentinel on a partial bridge update', async () => {
      // Regression guard: `bridgeSettingsSchema` declares
      // `instanceId: z.string().catch('')`, so parsing a partial patch
      // directly (rather than merging onto the current value first) would
      // silently reset the durable instance id to the unseeded sentinel —
      // and there is no repair path once that happens.
      const before = manager.get().bridge.instanceId
      expect(before).not.toBe('')

      await manager.update({ bridge: { fixedPort: 16900 } })

      expect(manager.get().bridge.instanceId).toBe(before)
      expect(manager.get().bridge.fixedPort).toBe(16900)
    })

    it('does not set requiresAppRestart when browserBridgeEnabled changes', async () => {
      // browserBridgeEnabled is hot-applied via BridgeManager.setEnabled() —
      // no app restart needed.
      const result = await manager.update({
        app: { browserBridgeEnabled: false },
      })

      expect(result.saved).toBe(true)
      expect(result.requiresAppRestart).toBe(false)
      expect(result.changedAppRestartKeys).not.toContain('browserBridgeEnabled')
    })

    it('does not set requiresAppRestart when launchAtStartup changes', async () => {
      // launchAtStartup is hot-applied via syncAutoLaunch() — no app restart needed.
      const result = await manager.update({
        app: { launchAtStartup: true },
      })

      expect(result.saved).toBe(true)
      expect(result.requiresAppRestart).toBe(false)
      expect(result.changedAppRestartKeys).not.toContain('launchAtStartup')
    })

    it('does not set requiresAppRestart for non-restart app keys', async () => {
      const result = await manager.update({
        app: { theme: 'dark' },
      })

      expect(result.requiresAppRestart).toBe(false)
      expect(result.changedAppRestartKeys).toHaveLength(0)
    })

    it('does not set requiresAppRestart when app namespace value is unchanged', async () => {
      // browserBridgeEnabled is not in APP_RESTART_REQUIRED_KEYS; no restart ever.
      const result = await manager.update({
        app: { browserBridgeEnabled: true },
      })

      expect(result.requiresAppRestart).toBe(false)
      expect(result.changedAppRestartKeys).toHaveLength(0)
    })

    it('merges media namespace on partial update', async () => {
      const result = await manager.update({
        media: { ffmpegBinaryPath: '/usr/local/bin/ffmpeg' },
      })
      expect(result.saved).toBe(true)
      expect(manager.get().media.ffmpegBinaryPath).toBe('/usr/local/bin/ffmpeg')
      // Untouched fields retain defaults
      expect(manager.get().media.ffmpegStagingMB).toBeGreaterThan(0)
    })

    it('round-trips a broader dashboard span without requiring restart', async () => {
      // Build a full-tile layout with the first tile's geometry customised.
      // parseTiles injects any missing default tiles, so saving a subset
      // causes the returned layout to differ from what was saved.  Using the
      // complete default tile list (with one tile modified) keeps the test
      // honest: the broader valid span must survive the round-trip and
      // requiresRestart must stay false — that is the real behavioral claim.
      const modifiedTile: DashboardTileLayout = {
        ...DEFAULT_DASHBOARD_LAYOUT.tiles[0],
        enabled: false,
        x: 1,
        y: 2,
        w: 3,
        h: 1,
      }
      const dashboard = {
        ...DEFAULT_DASHBOARD_LAYOUT,
        tiles: [modifiedTile, ...DEFAULT_DASHBOARD_LAYOUT.tiles.slice(1)],
      }

      const result = await manager.update({ dashboard })

      expect(result.saved).toBe(true)
      expect(result.requiresRestart).toBe(false)
      expect(result.requiresAppRestart).toBe(false)

      // The customised tile round-trips with its broader valid span.
      const returnedTile = manager
        .get()
        .dashboard.tiles.find((t) => t.id === modifiedTile.id)
      expect(returnedTile).toBeDefined()
      expect(returnedTile?.enabled).toBe(false)
      expect(returnedTile?.x).toBe(1)
      expect(returnedTile?.y).toBe(2)
      expect(returnedTile?.w).toBe(3)
      expect(returnedTile?.h).toBe(1)

      // Full layout persisted to disk.
      const writtenJson = mockedFs.writeFile.mock.calls.at(-1)?.[1] as string
      const persisted = JSON.parse(writtenJson)
      const persistedTile = persisted.dashboard.tiles.find(
        (t: { id: string }) => t.id === modifiedTile.id
      )
      expect(persistedTile?.enabled).toBe(false)
      expect(persistedTile?.x).toBe(1)
      expect(persistedTile?.y).toBe(2)
      expect(persistedTile?.w).toBe(3)
      expect(persistedTile?.h).toBe(1)
    })

    it('deep-merges speedLimit partial patch and preserves siblings', async () => {
      // Seed nested values the form would have saved earlier.
      await manager.update({
        speedLimit: {
          auto: { schedule: { days: [1, 2, 3] } },
          alt: { upload: 99 },
        },
      })

      expect(manager.get().speedLimit.auto.schedule.days).toEqual([1, 2, 3])
      expect(manager.get().speedLimit.alt.upload).toBe(99)

      // A later partial patch touches only alt.download.
      const result = await manager.update({
        speedLimit: { alt: { download: 1048576 } },
      })

      expect(result.saved).toBe(true)
      const { alt, auto } = manager.get().speedLimit
      // Patched field applied.
      expect(alt.download).toBe(1048576)
      // Sibling sub-fields preserved, not refilled with schema defaults.
      expect(alt.upload).toBe(99)
      expect(auto.schedule.days).toEqual([1, 2, 3])
    })

    it('persists tracker.sources when added via partial update', async () => {
      const originalCount = manager.get().tracker.sources.length
      const custom = {
        id: 'custom-test',
        label: 'custom',
        url: 'https://example.com/trackers.txt',
        builtin: false,
        enabled: true,
        cdn: false,
      }

      const result = await manager.update({
        tracker: {
          sources: [...manager.get().tracker.sources, custom],
        },
      })

      expect(result.saved).toBe(true)
      expect(manager.get().tracker.sources).toHaveLength(originalCount + 1)
      expect(manager.get().tracker.sources).toContainEqual(custom)
      // Other tracker fields retain defaults
      expect(manager.get().tracker.autoSync).toBe(true)
    })

    it('atomically removes only the uninstalled plugin configuration', async () => {
      await manager.update({
        plugins: {
          'plugin.remove': { apiKey: 'box:encrypted-secret' },
          'plugin.keep': { quality: '1080p' },
        },
      })

      const result = await manager.removePluginConfig('plugin.remove')

      expect(result.saved).toBe(true)
      expect(manager.get().plugins).toEqual({
        'plugin.keep': { quality: '1080p' },
      })
      const persisted = JSON.parse(
        mockedFs.writeFile.mock.calls.at(-1)?.[1] as string
      )
      expect(persisted.plugins).toEqual({
        'plugin.keep': { quality: '1080p' },
      })

      const writes = mockedFs.writeFile.mock.calls.length
      await expect(
        manager.removePluginConfig('plugin.remove')
      ).resolves.toMatchObject({ saved: false })
      expect(mockedFs.writeFile).toHaveBeenCalledTimes(writes)
    })
  })

  describe('save', () => {
    it('writes settings to disk as formatted JSON', async () => {
      mockedFs.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      await manager.load()
      await manager.save()

      // writeFileAtomic's third arg is an options object, not the
      // 'utf-8' encoding string accepted by node:fs writeFile.
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        TEST_PATH,
        expect.any(String),
        expect.objectContaining({ encoding: 'utf-8' })
      )

      const writtenJson = mockedFs.writeFile.mock.calls.at(-1)?.[1]
      expect(typeof writtenJson).toBe('string')
      const parsed = JSON.parse(writtenJson as string)
      expect(parsed.version).toBe(CURRENT_SETTINGS_VERSION)
    })

    it('creates parent directory if missing', async () => {
      mockedFs.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      await manager.load()
      await manager.save()

      expect(mockedFs.mkdir).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
      })
    })
  })

  describe('events', () => {
    beforeEach(async () => {
      mockedFs.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)
      await manager.load()
    })

    it('calls onChange callback on update', async () => {
      await manager.update({ app: { notifyOnComplete: false } })

      expect(onChange).toHaveBeenCalledOnce()
      const [old, updated] = onChange.mock.calls[0] as [
        AppSettings,
        AppSettings,
      ]
      expect(old.app.notifyOnComplete).toBe(true)
      expect(updated.app.notifyOnComplete).toBe(false)
    })
  })

  describe('tray defaults', () => {
    beforeEach(async () => {
      mockedFs.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)
      await manager.load()
    })

    it('applies default values for new tray fields', async () => {
      const app = manager.getApp()
      expect(app.runMode).toBe(1) // RunMode.Standard
      expect(app.traySpeedometer).toBe(true)
    })
  })

  describe('rpcSecret seeding', () => {
    it('preserves an explicitly persisted empty rpcSecret after load', async () => {
      const fileContent = JSON.stringify({
        version: CURRENT_SETTINGS_VERSION,
        engine: { rpcSecret: '' },
        app: { defaultSaveDir: '/downloads' },
      })
      mockedFs.readFile.mockResolvedValue(fileContent)
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      const sm = new SettingsManager(TEST_PATH)
      await sm.load()

      expect(sm.getEngine().rpcSecret).toBe('')
      expect(mockedFs.writeFile).not.toHaveBeenCalled()
    })

    it('seeds rpcSecret when the persisted field is missing', async () => {
      mockedFs.readFile.mockResolvedValue(
        JSON.stringify({
          version: CURRENT_SETTINGS_VERSION,
          engine: { rpcPort: 16800 },
        })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      const sm = new SettingsManager(TEST_PATH)
      await sm.load()

      expect(sm.getEngine().rpcSecret).not.toBe('')
      expect(sm.getEngine().rpcSecret.length).toBeGreaterThanOrEqual(8)

      const writtenJson = mockedFs.writeFile.mock.calls.at(-1)?.[1] as string
      const persisted = JSON.parse(writtenJson) as AppSettings
      expect(persisted.engine.rpcSecret).toBe(sm.getEngine().rpcSecret)
    })

    it.each([123, null])(
      'seeds rpcSecret when the persisted value is invalid',
      async (invalidSecret) => {
        mockedFs.readFile.mockResolvedValue(
          JSON.stringify({
            version: CURRENT_SETTINGS_VERSION,
            engine: { rpcSecret: invalidSecret },
          })
        )
        mockedFs.mkdir.mockResolvedValue(undefined)
        mockedFs.writeFile.mockResolvedValue(undefined)

        const sm = new SettingsManager(TEST_PATH)
        await sm.load()

        expect(sm.getEngine().rpcSecret).not.toBe('')
        expect(sm.getEngine().rpcSecret.length).toBeGreaterThanOrEqual(8)
        const persisted = JSON.parse(
          mockedFs.writeFile.mock.calls.at(-1)?.[1] as string
        ) as AppSettings
        expect(persisted.engine.rpcSecret).toBe(sm.getEngine().rpcSecret)
      }
    )

    it('preserves an explicit empty rpcSecret through migration', async () => {
      mockedFs.readFile.mockResolvedValue(
        JSON.stringify({
          version: CURRENT_SETTINGS_VERSION - 1,
          engine: { rpcSecret: '' },
        })
      )
      mockedFs.mkdir.mockResolvedValue(undefined)
      mockedFs.writeFile.mockResolvedValue(undefined)

      const sm = new SettingsManager(TEST_PATH)
      await sm.load()

      expect(sm.getEngine().rpcSecret).toBe('')
      const persisted = JSON.parse(
        mockedFs.writeFile.mock.calls.at(-1)?.[1] as string
      ) as AppSettings
      expect(persisted.version).toBe(CURRENT_SETTINGS_VERSION)
      expect(persisted.engine.rpcSecret).toBe('')
    })
  })
})
