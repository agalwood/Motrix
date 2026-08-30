import type { EngineSettings, MotrixAppSettings } from '@shared/types/settings'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_ENGINE_SETTINGS,
  DEFAULT_MEDIA_SETTINGS,
  DEFAULT_NAT_SETTINGS,
  engineSettingsSchema,
  mediaSettingsSchema,
  natSettingsSchema,
  validateAppSettings,
  validateEngineSettings,
  windowStateSchema,
} from './validators'

describe('windowStateSchema', () => {
  it('migrates legacy bounds to a non-maximized saved state', () => {
    expect(
      windowStateSchema.parse({
        main: { x: 100, y: 100, width: 1024, height: 768 },
      })
    ).toEqual({
      main: {
        x: 100,
        y: 100,
        width: 1024,
        height: 768,
        maximized: false,
      },
    })
  })
})

describe('validateEngineSettings', () => {
  it('returns defaults for empty object', () => {
    const result = validateEngineSettings({} as EngineSettings)
    expect(result).toEqual(DEFAULT_ENGINE_SETTINGS)
  })

  it('preserves valid values', () => {
    const input: EngineSettings = {
      ...DEFAULT_ENGINE_SETTINGS,
      rpcPort: 6800,
      maxConcurrentDownloads: 10,
    }
    const result = validateEngineSettings(input)
    expect(result.rpcPort).toBe(6800)
    expect(result.maxConcurrentDownloads).toBe(10)
  })

  it('clamps rpcPort to valid range (1024-65535)', () => {
    const tooLow = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      rpcPort: 80,
    })
    expect(tooLow.rpcPort).toBe(DEFAULT_ENGINE_SETTINGS.rpcPort)

    const tooHigh = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      rpcPort: 70000,
    })
    expect(tooHigh.rpcPort).toBe(DEFAULT_ENGINE_SETTINGS.rpcPort)
  })

  it('clamps listenPort to valid range (1024-65535)', () => {
    const tooLow = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      listenPort: 0,
    })
    expect(tooLow.listenPort).toBe(DEFAULT_ENGINE_SETTINGS.listenPort)
  })

  it('rejects non-integer maxConcurrentDownloads', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      maxConcurrentDownloads: 3.5,
    })
    expect(result.maxConcurrentDownloads).toBe(
      DEFAULT_ENGINE_SETTINGS.maxConcurrentDownloads
    )
  })

  it('clamps split to valid range (1-128)', () => {
    const tooLow = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      split: 0,
    })
    expect(tooLow.split).toBe(DEFAULT_ENGINE_SETTINGS.split)

    const tooHigh = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      split: 256,
    })
    expect(tooHigh.split).toBe(DEFAULT_ENGINE_SETTINGS.split)
  })

  it('clamps maxConnectionPerServer to valid range (1-64)', () => {
    const atLimit = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      maxConnectionPerServer: 64,
    })
    expect(atLimit.maxConnectionPerServer).toBe(64)

    const tooHigh = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      maxConnectionPerServer: 65,
    })
    expect(tooHigh.maxConnectionPerServer).toBe(
      DEFAULT_ENGINE_SETTINGS.maxConnectionPerServer
    )
  })

  it('rejects non-string rpcSecret', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      rpcSecret: 123 as unknown as string,
    })
    expect(result.rpcSecret).toBe(DEFAULT_ENGINE_SETTINGS.rpcSecret)
  })

  it('rejects non-string userAgent', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      userAgent: null as unknown as string,
    })
    expect(result.userAgent).toBe(DEFAULT_ENGINE_SETTINGS.userAgent)
  })

  it('rejects control characters in RPC credentials and User-Agent', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      rpcSecret: 'secret\nrpc-listen-all=true',
      userAgent: 'Motrix\nhttp-proxy=http://evil',
    })

    expect(result.rpcSecret).toBe('')
    expect(result.userAgent).toBe(DEFAULT_ENGINE_SETTINGS.userAgent)
  })

  it('uses the Motrix 2.0 default user agent', () => {
    expect(DEFAULT_ENGINE_SETTINGS.userAgent).toBe('Motrix/2.0')
  })

  it('rejects sessionSaveInterval below minimum 10', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      sessionSaveInterval: 3,
    })
    expect(result.sessionSaveInterval).toBe(
      DEFAULT_ENGINE_SETTINGS.sessionSaveInterval
    )
  })

  it('rejects minSplitSize below minimum 1048576 (1M)', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      minSplitSize: 100,
    })
    expect(result.minSplitSize).toBe(DEFAULT_ENGINE_SETTINGS.minSplitSize)
  })

  it('defaults all newly added L3 fields', () => {
    expect(DEFAULT_ENGINE_SETTINGS.connectTimeout).toBe(30)
    expect(DEFAULT_ENGINE_SETTINGS.socketTimeout).toBe(30)
    expect(DEFAULT_ENGINE_SETTINGS.maxTries).toBe(5)
    expect(DEFAULT_ENGINE_SETTINGS.retryWait).toBe(10)
    expect(DEFAULT_ENGINE_SETTINGS.lowestSpeedLimit).toBe(0)
    expect(DEFAULT_ENGINE_SETTINGS.btMaxPeers).toBe(128)
    expect(DEFAULT_ENGINE_SETTINGS.btEnableLpd).toBe(true)
    expect(DEFAULT_ENGINE_SETTINGS.seedRatio).toBe(1)
    expect(DEFAULT_ENGINE_SETTINGS.seedTime).toBe(60)
  })

  it('preserves valid network reliability values', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      connectTimeout: 15,
      socketTimeout: 45,
      maxTries: 10,
      retryWait: 20,
      lowestSpeedLimit: 1024,
    })
    expect(result.connectTimeout).toBe(15)
    expect(result.socketTimeout).toBe(45)
    expect(result.maxTries).toBe(10)
    expect(result.retryWait).toBe(20)
    expect(result.lowestSpeedLimit).toBe(1024)
  })

  it('clamps connectTimeout out-of-range values to default', () => {
    const tooLow = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      connectTimeout: 0,
    })
    expect(tooLow.connectTimeout).toBe(DEFAULT_ENGINE_SETTINGS.connectTimeout)

    const tooHigh = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      connectTimeout: 9999,
    })
    expect(tooHigh.connectTimeout).toBe(DEFAULT_ENGINE_SETTINGS.connectTimeout)
  })

  it('accepts maxTries=0 (aria2 unlimited semantics)', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      maxTries: 0,
    })
    expect(result.maxTries).toBe(0)
  })

  it('rejects negative lowestSpeedLimit', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      lowestSpeedLimit: -1,
    })
    expect(result.lowestSpeedLimit).toBe(0)
  })

  it('preserves valid BT field values', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      btMaxPeers: 256,
      btEnableLpd: false,
      seedRatio: 2.5,
      seedTime: 120,
    })
    expect(result.btMaxPeers).toBe(256)
    expect(result.btEnableLpd).toBe(false)
    expect(result.seedRatio).toBe(2.5)
    expect(result.seedTime).toBe(120)
  })

  it('clamps btMaxPeers above 1000 to default', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      btMaxPeers: 5000,
    })
    expect(result.btMaxPeers).toBe(DEFAULT_ENGINE_SETTINGS.btMaxPeers)
  })

  it('accepts seedTime=0 (seed forever) and seedRatio=0 (no ratio limit)', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      seedTime: 0,
      seedRatio: 0,
    })
    expect(result.seedTime).toBe(0)
    expect(result.seedRatio).toBe(0)
  })

  it('rejects negative seedRatio', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      seedRatio: -1,
    })
    expect(result.seedRatio).toBe(DEFAULT_ENGINE_SETTINGS.seedRatio)
  })

  it('rejects non-boolean btEnableLpd', () => {
    const result = validateEngineSettings({
      ...DEFAULT_ENGINE_SETTINGS,
      btEnableLpd: 'yes' as unknown as boolean,
    })
    expect(result.btEnableLpd).toBe(DEFAULT_ENGINE_SETTINGS.btEnableLpd)
  })
})

describe('validateAppSettings', () => {
  it('returns defaults for empty object', () => {
    const result = validateAppSettings({} as MotrixAppSettings)
    expect(result).toEqual(DEFAULT_APP_SETTINGS)
  })

  it('preserves valid values', () => {
    const input: MotrixAppSettings = {
      ...DEFAULT_APP_SETTINGS,
      theme: 'dark',
      language: 'zh-CN',
    }
    const result = validateAppSettings(input)
    expect(result.theme).toBe('dark')
    expect(result.language).toBe('zh-CN')
  })

  it('rejects invalid theme values', () => {
    const result = validateAppSettings({
      ...DEFAULT_APP_SETTINGS,
      theme: 'blue' as MotrixAppSettings['theme'],
    })
    expect(result.theme).toBe(DEFAULT_APP_SETTINGS.theme)
  })

  it('rejects non-boolean launchAtStartup', () => {
    const result = validateAppSettings({
      ...DEFAULT_APP_SETTINGS,
      launchAtStartup: 'yes' as unknown as boolean,
    })
    expect(result.launchAtStartup).toBe(DEFAULT_APP_SETTINGS.launchAtStartup)
  })

  it('rejects non-string defaultSaveDir', () => {
    const result = validateAppSettings({
      ...DEFAULT_APP_SETTINGS,
      defaultSaveDir: 42 as unknown as string,
    })
    expect(result.defaultSaveDir).toBe(DEFAULT_APP_SETTINGS.defaultSaveDir)
  })

  it('accepts empty defaultSaveDir as sentinel (SettingsManager seeds at load)', () => {
    const result = validateAppSettings({
      ...DEFAULT_APP_SETTINGS,
      defaultSaveDir: '',
    })
    // Empty is the documented sentinel: src/shared/ may not depend on
    // node:os/path, so the absolute Downloads path is resolved by
    // SettingsManager.seedSentinels() in main/server runtimes.
    expect(result.defaultSaveDir).toBe('')
  })

  it('rejects non-boolean notifyOnComplete', () => {
    const result = validateAppSettings({
      ...DEFAULT_APP_SETTINGS,
      notifyOnComplete: 1 as unknown as boolean,
    })
    expect(result.notifyOnComplete).toBe(DEFAULT_APP_SETTINGS.notifyOnComplete)
  })

  it('returns default protocols for empty object', () => {
    const result = validateAppSettings({} as MotrixAppSettings)
    expect(result.protocols).toEqual({ magnet: true })
  })

  it('preserves valid protocols', () => {
    const result = validateAppSettings({
      ...DEFAULT_APP_SETTINGS,
      protocols: { magnet: false },
    })
    expect(result.protocols.magnet).toBe(false)
  })

  it('falls back to default for invalid protocols', () => {
    const result = validateAppSettings({
      ...DEFAULT_APP_SETTINGS,
      protocols: 'invalid' as unknown as MotrixAppSettings['protocols'],
    })
    expect(result.protocols).toEqual({ magnet: true })
  })

  it('defaults Liquid Glass effect to disabled', () => {
    const result = validateAppSettings({} as MotrixAppSettings)
    expect(result.liquidGlassEffect).toBe(false)
  })

  it('preserves valid Liquid Glass effect setting', () => {
    const result = validateAppSettings({
      ...DEFAULT_APP_SETTINGS,
      liquidGlassEffect: true,
    })
    expect(result.liquidGlassEffect).toBe(true)
  })

  it('defaults warnBeforeQuit to true', () => {
    expect(DEFAULT_APP_SETTINGS.warnBeforeQuit).toBe(true)
  })

  it('falls back warnBeforeQuit to true on invalid input', () => {
    const result = validateAppSettings({
      ...DEFAULT_APP_SETTINGS,
      warnBeforeQuit: 'nope' as unknown as boolean,
    })
    expect(result.warnBeforeQuit).toBe(true)
  })

  it('checks for updates on launch by default', () => {
    expect(DEFAULT_APP_SETTINGS.checkForUpdatesOnLaunch).toBe(true)
  })

  it('falls back checkForUpdatesOnLaunch to true on invalid input', () => {
    const result = validateAppSettings({
      ...DEFAULT_APP_SETTINGS,
      checkForUpdatesOnLaunch: 'nope' as unknown as boolean,
    })
    expect(result.checkForUpdatesOnLaunch).toBe(true)
  })

  it('uses the stable application update channel by default', () => {
    expect(DEFAULT_APP_SETTINGS.updateChannel).toBe('stable')
  })

  it('preserves beta and rejects unknown application update channels', () => {
    expect(
      validateAppSettings({
        ...DEFAULT_APP_SETTINGS,
        updateChannel: 'beta',
      }).updateChannel
    ).toBe('beta')
    expect(
      validateAppSettings({
        ...DEFAULT_APP_SETTINGS,
        updateChannel: 'alpha' as MotrixAppSettings['updateChannel'],
      }).updateChannel
    ).toBe('stable')
  })
})

describe('engineSettingsSchema — dhtListenPort', () => {
  it('defaults dhtListenPort to 6881', () => {
    expect(DEFAULT_ENGINE_SETTINGS.dhtListenPort).toBe(6881)
  })

  it('accepts valid dhtListenPort', () => {
    const parsed = engineSettingsSchema.parse({
      ...DEFAULT_ENGINE_SETTINGS,
      dhtListenPort: 51413,
    })
    expect(parsed.dhtListenPort).toBe(51413)
  })

  it('falls back to default when dhtListenPort is invalid', () => {
    const parsed = engineSettingsSchema.parse({
      ...DEFAULT_ENGINE_SETTINGS,
      dhtListenPort: 999,
    })
    expect(parsed.dhtListenPort).toBe(6881)
  })

  it('rejects dhtListenPort above 65535 and uses default', () => {
    const parsed = engineSettingsSchema.parse({
      ...DEFAULT_ENGINE_SETTINGS,
      dhtListenPort: 70000,
    })
    expect(parsed.dhtListenPort).toBe(6881)
  })
})

describe('SQLite3 persistence fields', () => {
  it('accepts valid sqlite3Persistence boolean', () => {
    const result = engineSettingsSchema.parse({
      ...DEFAULT_ENGINE_SETTINGS,
      sqlite3Persistence: false,
    })
    expect(result.sqlite3Persistence).toBe(false)
  })

  it('falls back to true when sqlite3Persistence is invalid', () => {
    const result = engineSettingsSchema.parse({
      ...DEFAULT_ENGINE_SETTINGS,
      sqlite3Persistence: 'yes' as unknown as boolean,
    })
    expect(result.sqlite3Persistence).toBe(true)
  })

  it('accepts non-empty sqlite3DbPath', () => {
    const result = engineSettingsSchema.parse({
      ...DEFAULT_ENGINE_SETTINGS,
      sqlite3DbPath: '/var/lib/motrix/aria2.db',
    })
    expect(result.sqlite3DbPath).toBe('/var/lib/motrix/aria2.db')
  })

  it('falls back to empty when sqlite3DbPath contains a null byte', () => {
    const result = engineSettingsSchema.parse({
      ...DEFAULT_ENGINE_SETTINGS,
      sqlite3DbPath: '/bad\0path',
    })
    expect(result.sqlite3DbPath).toBe('')
  })

  it('accepts -1, 0, and positive sqlite3HistoryLimit', () => {
    expect(
      engineSettingsSchema.parse({
        ...DEFAULT_ENGINE_SETTINGS,
        sqlite3HistoryLimit: -1,
      }).sqlite3HistoryLimit
    ).toBe(-1)
    expect(
      engineSettingsSchema.parse({
        ...DEFAULT_ENGINE_SETTINGS,
        sqlite3HistoryLimit: 0,
      }).sqlite3HistoryLimit
    ).toBe(0)
    expect(
      engineSettingsSchema.parse({
        ...DEFAULT_ENGINE_SETTINGS,
        sqlite3HistoryLimit: 50000,
      }).sqlite3HistoryLimit
    ).toBe(50000)
  })

  it('falls back to -1 when sqlite3HistoryLimit is below -1', () => {
    const result = engineSettingsSchema.parse({
      ...DEFAULT_ENGINE_SETTINGS,
      sqlite3HistoryLimit: -2,
    })
    expect(result.sqlite3HistoryLimit).toBe(-1)
  })
})

describe('natSettingsSchema', () => {
  it('enables core mapping by default', () => {
    expect(DEFAULT_NAT_SETTINGS.enabled).toBe(true)
    expect(DEFAULT_NAT_SETTINGS.preferredProtocol).toBe('auto')
    expect(DEFAULT_NAT_SETTINGS.mappingTtl).toBe(7200)
  })

  it('disables privacy-sensitive features by default', () => {
    expect(DEFAULT_NAT_SETTINGS.natTypeDetectionEnabled).toBe(false)
    expect(DEFAULT_NAT_SETTINGS.portReachabilityCheckEnabled).toBe(false)
    expect(DEFAULT_NAT_SETTINGS.autoDiagnostic).toBe(false)
  })

  it('ships with no pre-seeded STUN or port-check endpoints', () => {
    expect(DEFAULT_NAT_SETTINGS.stunServers).toEqual([])
    expect(DEFAULT_NAT_SETTINGS.portCheckerEndpoints).toEqual([])
  })

  it('rejects mappingTtl below 1200 and uses default', () => {
    const parsed = natSettingsSchema.parse({ mappingTtl: 600 })
    expect(parsed.mappingTtl).toBe(7200)
  })

  it('rejects mappingTtl above 7200 and uses default', () => {
    const parsed = natSettingsSchema.parse({ mappingTtl: 14400 })
    expect(parsed.mappingTtl).toBe(7200)
  })

  it('accepts mappingTtl at exactly 7200', () => {
    const parsed = natSettingsSchema.parse({ mappingTtl: 7200 })
    expect(parsed.mappingTtl).toBe(7200)
  })

  it('accepts valid STUN server strings', () => {
    const parsed = natSettingsSchema.parse({
      stunServers: ['stun.example.com:3478', 'stun2.example.org:19302'],
    })
    expect(parsed.stunServers).toHaveLength(2)
  })

  it('rejects malformed STUN server strings', () => {
    const parsed = natSettingsSchema.parse({
      stunServers: ['not a server', 'stun.example.com'],
    })
    expect(parsed.stunServers).toEqual([])
  })

  it('limits STUN server list length to 10', () => {
    const many = new Array(20).fill('stun.example.com:3478')
    const parsed = natSettingsSchema.parse({ stunServers: many })
    expect(parsed.stunServers).toEqual([])
  })

  it('requires HTTPS for portCheckerEndpoints', () => {
    const parsed = natSettingsSchema.parse({
      portCheckerEndpoints: ['http://insecure.example.com/check'],
    })
    expect(parsed.portCheckerEndpoints).toEqual([])
  })
})

describe('mediaSettingsSchema', () => {
  it('parses defaults from empty object', () => {
    expect(DEFAULT_MEDIA_SETTINGS).toEqual({
      ffmpegBinaryPath: '',
      ffmpegStagingMB: 4096,
      ffmpegOpTimeoutSec: 1800,
    })
  })

  it('catches invalid values and falls back to defaults', () => {
    const out = mediaSettingsSchema.parse({
      ffmpegStagingMB: 'oops',
      ffmpegOpTimeoutSec: 99999,
    } as unknown)
    expect(out).toEqual(DEFAULT_MEDIA_SETTINGS)
  })

  it('accepts valid values', () => {
    expect(
      mediaSettingsSchema.parse({
        ffmpegBinaryPath: '/u/bin/ffmpeg',
        ffmpegStagingMB: 2048,
        ffmpegOpTimeoutSec: 600,
      })
    ).toEqual({
      ffmpegBinaryPath: '/u/bin/ffmpeg',
      ffmpegStagingMB: 2048,
      ffmpegOpTimeoutSec: 600,
    })
  })
})
