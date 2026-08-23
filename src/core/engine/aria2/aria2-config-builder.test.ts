import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock node:fs/promises ───────────────────────────────────

const { mockAccess, mockCopyFile, mockMkdir } = vi.hoisted(() => ({
  mockAccess: vi.fn(),
  mockCopyFile: vi.fn(),
  mockMkdir: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  default: {
    access: mockAccess,
    copyFile: mockCopyFile,
    mkdir: mockMkdir,
  },
  access: mockAccess,
  copyFile: mockCopyFile,
  mkdir: mockMkdir,
}))

import { DEFAULT_ENGINE_SETTINGS } from '@core/settings/validators'
import type { EngineSettings } from '@shared/types/settings'
import { Aria2ConfigBuilder } from './aria2-config-builder'

function makeEngineSettings(
  overrides?: Partial<EngineSettings>
): EngineSettings {
  return {
    ...DEFAULT_ENGINE_SETTINGS,
    sqlite3Persistence: true,
    sqlite3DbPath: '',
    sqlite3HistoryLimit: -1,
    ...overrides,
  }
}

describe('Aria2ConfigBuilder', () => {
  let builder: Aria2ConfigBuilder

  beforeEach(() => {
    vi.clearAllMocks()
    builder = new Aria2ConfigBuilder(
      '/app/extra/aria2.conf',
      '/home/user/.config/motrix'
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('ensureUserConfig', () => {
    it('returns existing user config path when file exists', async () => {
      // access resolves → file exists
      mockAccess.mockResolvedValue(undefined)

      const confPath = await builder.ensureUserConfig()

      expect(confPath).toBe('/home/user/.config/motrix/aria2.conf')
      expect(mockCopyFile).not.toHaveBeenCalled()
    })

    it('copies template when user config does not exist', async () => {
      // First access rejects → file missing
      mockAccess.mockRejectedValue(new Error('ENOENT: no such file'))
      mockMkdir.mockResolvedValue(undefined)
      mockCopyFile.mockResolvedValue(undefined)

      const confPath = await builder.ensureUserConfig()

      expect(confPath).toBe('/home/user/.config/motrix/aria2.conf')
      expect(mockMkdir).toHaveBeenCalledWith('/home/user/.config/motrix', {
        recursive: true,
      })
      expect(mockCopyFile).toHaveBeenCalledWith(
        '/app/extra/aria2.conf',
        '/home/user/.config/motrix/aria2.conf'
      )
    })
  })

  describe('buildArgs', () => {
    it('builds args array with default settings', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })

      expect(args).toContain('--conf-path=/home/user/.config/motrix/aria2.conf')
      expect(args).toContain('--enable-rpc=true')
      expect(args).toContain('--rpc-allow-origin-all=true')
      expect(args).toContain('--rpc-listen-all=false')
      expect(args).toContain(
        `--rpc-listen-port=${DEFAULT_ENGINE_SETTINGS.rpcPort}`
      )
      expect(args).toContain(
        `--rpc-secret=${DEFAULT_ENGINE_SETTINGS.rpcSecret}`
      )
      expect(args).toContain(
        `--enable-dht=${DEFAULT_ENGINE_SETTINGS.dhtEnabled}`
      )
      expect(args).toContain(
        `--enable-dht6=${DEFAULT_ENGINE_SETTINGS.dhtEnabled}`
      )
      expect(args).toContain(
        `--listen-port=${DEFAULT_ENGINE_SETTINGS.listenPort}`
      )
      expect(args).toContain(
        `--dht-listen-port=${DEFAULT_ENGINE_SETTINGS.dhtListenPort}`
      )
    })

    it('includes save-session path in userConfigDir', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })

      const saveSessionArg = args.find((a) => a.startsWith('--save-session='))
      expect(saveSessionArg).toBe(
        '--save-session=/home/user/.config/motrix/aria2.session'
      )
    })

    it('keeps DHT state inside the writable user config directory', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain(
        '--dht-file-path=/home/user/.config/motrix/dht.dat'
      )
      expect(args).toContain(
        '--dht-file-path6=/home/user/.config/motrix/dht6.dat'
      )
    })

    it('uses custom settings values', () => {
      const custom: EngineSettings = {
        ...DEFAULT_ENGINE_SETTINGS,
        rpcPort: 6800,
        rpcSecret: 'custom-key',
        dhtEnabled: false,
        listenPort: 6882,
      }

      const args = builder.buildArgs(custom, true, null, {
        download: 0,
        upload: 0,
      })

      expect(args).toContain('--rpc-listen-port=6800')
      expect(args).toContain('--rpc-secret=custom-key')
      expect(args).toContain('--enable-dht=false')
      expect(args).toContain('--listen-port=6882')
    })

    it('always starts with --conf-path', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })

      expect(args[0]).toMatch(/^--conf-path=/)
    })

    it('returns a new array on each call', () => {
      const args1 = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      const args2 = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })

      expect(args1).not.toBe(args2)
      expect(args1).toEqual(args2)
    })

    it('includes file-allocation and disk-cache args', () => {
      const settings: EngineSettings = {
        ...DEFAULT_ENGINE_SETTINGS,
        fileAllocation: 'falloc',
        diskCache: 33554432,
      }
      const args = builder.buildArgs(settings, true, null, {
        download: 0,
        upload: 0,
      })

      expect(args).toContain('--file-allocation=falloc')
      expect(args).toContain('--disk-cache=33554432')
    })

    it('includes default file-allocation and disk-cache', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })

      expect(args).toContain('--file-allocation=none')
      expect(args).toContain(
        `--disk-cache=${DEFAULT_ENGINE_SETTINGS.diskCache}`
      )
    })
  })

  describe('L3 user-tunable flags', () => {
    it('injects all performance flags', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })

      expect(args).toContain(
        `--max-concurrent-downloads=${DEFAULT_ENGINE_SETTINGS.maxConcurrentDownloads}`
      )
      expect(args).toContain('--max-overall-download-limit=0')
      expect(args).toContain('--max-overall-upload-limit=0')
      expect(args).toContain(
        `--max-connection-per-server=${DEFAULT_ENGINE_SETTINGS.maxConnectionPerServer}`
      )
      expect(args).toContain(`--split=${DEFAULT_ENGINE_SETTINGS.split}`)
      expect(args).toContain(
        `--min-split-size=${DEFAULT_ENGINE_SETTINGS.minSplitSize}`
      )
    })

    it('injects all network-reliability flags', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })

      expect(args).toContain(
        `--user-agent=${DEFAULT_ENGINE_SETTINGS.userAgent}`
      )
      expect(args).toContain(
        `--connect-timeout=${DEFAULT_ENGINE_SETTINGS.connectTimeout}`
      )
      expect(args).toContain(
        `--timeout=${DEFAULT_ENGINE_SETTINGS.socketTimeout}`
      )
      expect(args).toContain(`--max-tries=${DEFAULT_ENGINE_SETTINGS.maxTries}`)
      expect(args).toContain(
        `--retry-wait=${DEFAULT_ENGINE_SETTINGS.retryWait}`
      )
      expect(args).toContain(
        `--lowest-speed-limit=${DEFAULT_ENGINE_SETTINGS.lowestSpeedLimit}`
      )
      expect(args).toContain('--remote-time=false')
    })

    it('injects all BitTorrent flags', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })

      expect(args).toContain(
        `--bt-max-peers=${DEFAULT_ENGINE_SETTINGS.btMaxPeers}`
      )
      expect(args).toContain(
        `--bt-enable-lpd=${DEFAULT_ENGINE_SETTINGS.btEnableLpd}`
      )
      expect(args).toContain(
        `--seed-ratio=${DEFAULT_ENGINE_SETTINGS.seedRatio}`
      )
      expect(args).toContain(`--seed-time=${DEFAULT_ENGINE_SETTINGS.seedTime}`)
    })

    it('injects session-save-interval', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain(
        `--save-session-interval=${DEFAULT_ENGINE_SETTINGS.sessionSaveInterval}`
      )
    })

    it('honors custom values for new fields', () => {
      const custom: EngineSettings = {
        ...DEFAULT_ENGINE_SETTINGS,
        connectTimeout: 15,
        socketTimeout: 45,
        maxTries: 0,
        retryWait: 5,
        lowestSpeedLimit: 1024,
        remoteTime: true,
        btMaxPeers: 256,
        btEnableLpd: false,
        seedRatio: 2,
        seedTime: 0,
      }
      const args = builder.buildArgs(custom, true, null, {
        download: 0,
        upload: 0,
      })

      expect(args).toContain('--connect-timeout=15')
      expect(args).toContain('--timeout=45')
      expect(args).toContain('--max-tries=0')
      expect(args).toContain('--retry-wait=5')
      expect(args).toContain('--lowest-speed-limit=1024')
      expect(args).toContain('--remote-time=true')
      expect(args).toContain('--bt-max-peers=256')
      expect(args).toContain('--bt-enable-lpd=false')
      expect(args).toContain('--seed-ratio=2')
      expect(args).toContain('--seed-time=0')
    })
  })

  describe('SQLite3-Persistence flags (fork)', () => {
    const baseSettings = makeEngineSettings({
      sqlite3Persistence: true,
      sqlite3DbPath: '',
      sqlite3HistoryLimit: -1,
    })

    it('injects --enable-sqlite3-persistence with the configured boolean', () => {
      const args = builder.buildArgs(baseSettings, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain('--enable-sqlite3-persistence=true')
    })

    it('uses default DB path when sqlite3DbPath is empty', () => {
      const args = builder.buildArgs(baseSettings, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain(
        '--sqlite3-db-path=/home/user/.config/motrix/aria2.db'
      )
    })

    it('uses explicit DB path when sqlite3DbPath is set', () => {
      const args = builder.buildArgs(
        { ...baseSettings, sqlite3DbPath: '/custom/path/db.sqlite' },
        true,
        null,
        { download: 0, upload: 0 }
      )
      expect(args).toContain('--sqlite3-db-path=/custom/path/db.sqlite')
      expect(args).not.toContain(
        '--sqlite3-db-path=/home/user/.config/motrix/aria2.db'
      )
    })

    it('passes -1 history limit through verbatim', () => {
      const args = builder.buildArgs(baseSettings, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain('--sqlite3-history-limit=-1')
    })

    it('passes 0 and positive history limits through verbatim', () => {
      expect(
        builder.buildArgs(
          { ...baseSettings, sqlite3HistoryLimit: 0 },
          true,
          null,
          { download: 0, upload: 0 }
        )
      ).toContain('--sqlite3-history-limit=0')
      expect(
        builder.buildArgs(
          { ...baseSettings, sqlite3HistoryLimit: 10000 },
          true,
          null,
          { download: 0, upload: 0 }
        )
      ).toContain('--sqlite3-history-limit=10000')
    })

    it('omits all three sqlite flags when hasSqlitePersistence=false', () => {
      const args = builder.buildArgs(baseSettings, false, null, {
        download: 0,
        upload: 0,
      })
      expect(
        args.find((a) => a.startsWith('--enable-sqlite3-persistence'))
      ).toBeUndefined()
      expect(
        args.find((a) => a.startsWith('--sqlite3-db-path'))
      ).toBeUndefined()
      expect(
        args.find((a) => a.startsWith('--sqlite3-history-limit'))
      ).toBeUndefined()
    })

    it('keeps L1 invariants at the tail regardless of flag injection', () => {
      const args = builder.buildArgs(baseSettings, true, null, {
        download: 0,
        upload: 0,
      })
      const btSaveIndex = args.indexOf('--bt-save-metadata=true')
      const sqliteIndex = args.findIndex((a) =>
        a.startsWith('--enable-sqlite3-persistence')
      )
      expect(btSaveIndex).toBeGreaterThan(sqliteIndex)
    })
  })

  describe('incomplete-suffix required defaults', () => {
    it('sets bt-save-metadata=true', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain('--bt-save-metadata=true')
    })

    it('sets bt-metadata-only=false', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain('--bt-metadata-only=false')
    })

    it('sets auto-file-renaming=false', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain('--auto-file-renaming=false')
    })

    it('sets allow-overwrite=false', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain('--allow-overwrite=false')
    })

    it('sets rpc-save-upload-metadata=true', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain('--rpc-save-upload-metadata=true')
    })

    it('emits the required defaults regardless of hasSqlitePersistence', () => {
      const argsWith = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      const argsWithout = builder.buildArgs(
        DEFAULT_ENGINE_SETTINGS,
        false,
        null,
        { download: 0, upload: 0 }
      )

      for (const args of [argsWith, argsWithout]) {
        expect(args).toContain('--bt-save-metadata=true')
        expect(args).toContain('--bt-metadata-only=false')
        expect(args).toContain('--auto-file-renaming=false')
        expect(args).toContain('--allow-overwrite=false')
        expect(args).toContain('--rpc-save-upload-metadata=true')
      }
    })
  })

  describe('buildArgs effective limits', () => {
    it('injects effective limits into the args', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 999,
        upload: 111,
      })
      expect(args).toContain('--max-overall-download-limit=999')
      expect(args).toContain('--max-overall-upload-limit=111')
    })

    it('emits 0/0 when unlimited', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain('--max-overall-download-limit=0')
      expect(args).toContain('--max-overall-upload-limit=0')
    })
  })

  describe('buildArgs proxy injection', () => {
    const baseProxy = {
      enabled: true,
      protocol: 'http' as const,
      host: 'p.example.com',
      port: 8080,
      user: '',
      password: '',
      bypass: [] as string[],
      scopes: { download: true, updateApp: false, updateTrackers: false },
    }

    it('injects --all-proxy when proxy enabled and download scope on', () => {
      const args = builder.buildArgs(makeEngineSettings(), true, baseProxy, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain('--all-proxy=http://p.example.com:8080')
    })

    it('injects --no-proxy when bypass list non-empty', () => {
      const args = builder.buildArgs(
        makeEngineSettings(),
        true,
        {
          ...baseProxy,
          bypass: ['localhost', '127.0.0.1'],
        },
        { download: 0, upload: 0 }
      )
      expect(args).toContain('--no-proxy=localhost,127.0.0.1')
    })

    it('omits --no-proxy when bypass empty', () => {
      const args = builder.buildArgs(makeEngineSettings(), true, baseProxy, {
        download: 0,
        upload: 0,
      })
      expect(args.some((a) => a.startsWith('--no-proxy='))).toBe(false)
    })

    it('omits proxy args when proxy is null', () => {
      const args = builder.buildArgs(makeEngineSettings(), true, null, {
        download: 0,
        upload: 0,
      })
      expect(args.some((a) => a.startsWith('--all-proxy='))).toBe(false)
    })

    it('omits proxy args when scope off', () => {
      const args = builder.buildArgs(
        makeEngineSettings(),
        true,
        {
          ...baseProxy,
          scopes: { download: false, updateApp: false, updateTrackers: false },
        },
        { download: 0, upload: 0 }
      )
      expect(args.some((a) => a.startsWith('--all-proxy='))).toBe(false)
    })

    it('omits proxy args when proxy disabled', () => {
      const args = builder.buildArgs(
        makeEngineSettings(),
        true,
        {
          ...baseProxy,
          enabled: false,
        },
        { download: 0, upload: 0 }
      )
      expect(args.some((a) => a.startsWith('--all-proxy='))).toBe(false)
    })
  })

  describe('L1 product-contract invariants', () => {
    it('sets force-save=true', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain('--force-save=true')
    })

    it('sets pause=false on add', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain('--pause=false')
      expect(args).toContain('--pause-metadata=false')
    })

    it('keeps bt-seed-unverified=false (per-task only via finalizeTask)', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain('--bt-seed-unverified=false')
    })

    it('sets bt-remove-unselected-file=true so partial placeholders are cleaned by aria2', () => {
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      expect(args).toContain('--bt-remove-unselected-file=true')
    })

    it('places L1 invariants after L3 user-tunable so duplicates resolve to L1', () => {
      // aria2 honors the LAST occurrence of a duplicated flag. The L1
      // contract guarantees a user-edited L4 conf cannot override these.
      const args = builder.buildArgs(DEFAULT_ENGINE_SETTINGS, true, null, {
        download: 0,
        upload: 0,
      })
      const idxBtSaveMetadata = args.indexOf('--bt-save-metadata=true')
      const idxSplit = args.findIndex((a) => a.startsWith('--split='))
      expect(idxBtSaveMetadata).toBeGreaterThan(idxSplit)
    })
  })

  describe('dns resolution mode', () => {
    it.each([
      ['auto', '--async-dns=true'],
      ['engine', '--async-dns=true'],
      ['system', '--async-dns=false'],
    ] as const)('emits %s as %s', (dnsMode, flag) => {
      const args = builder.buildArgs(
        makeEngineSettings({ dnsMode }),
        true,
        null,
        { download: 0, upload: 0 }
      )

      expect(args).toContain(flag)
    })
  })
})
