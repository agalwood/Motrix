import { ErrorCode } from '@shared/errors'
import type { EngineFeatureReport } from '@shared/types/engine'
import type { Mock } from 'vitest'
import { describe, expect, it, vi } from 'vitest'
import type { CreateDownloadParams } from '../engine-adapter'
import { DIRECT_RESOURCE_METADATA_PROFILE } from '../engine-adapter'
import {
  Aria2Adapter,
  directResourceMetadataProfileFromGlobalOptions,
} from './aria2-adapter'
import type { Aria2RpcClient } from './aria2-rpc-client'
import type { Aria2RawFile, Aria2RawGlobalStat, Aria2RawStatus } from './types'

// ─── Mock RpcClient ─────────────────────────────────────────

function createMockRpc(): Aria2RpcClient {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    addUri: vi.fn(),
    addTorrent: vi.fn(),
    addMetalink: vi.fn(),
    remove: vi.fn(),
    forceRemove: vi.fn(),
    removeDownloadResult: vi.fn(),
    multicallSettled: vi.fn(),
    pause: vi.fn(),
    unpause: vi.fn(),
    pauseAll: vi.fn(),
    unpauseAll: vi.fn(),
    changePosition: vi.fn(),
    tellStatus: vi.fn(),
    tellActive: vi.fn(),
    tellWaiting: vi.fn(),
    tellStopped: vi.fn(),
    getFiles: vi.fn(),
    getGlobalStat: vi.fn(),
    getGlobalOption: vi.fn(),
    getVersion: vi.fn(),
    onBtDownloadComplete: vi.fn(),
    onDownloadComplete: vi.fn(),
    onDownloadError: vi.fn(),
    getOption: vi.fn(),
    getDownloadResultCount: vi.fn(),
    searchDownloadResult: vi.fn(),
    exportSession: vi.fn(),
    requeueDownloadResult: vi.fn(),
  } as unknown as Aria2RpcClient
}

function featureReport(
  overrides: Partial<EngineFeatureReport> = {}
): EngineFeatureReport {
  return {
    version: '1.37.0-motrix.10',
    features: ['SQLite3-Persistence'],
    hasSqlitePersistence: true,
    hasBtSeedUnverified: true,
    hasBtSaveMetadata: true,
    hasMoveStorage: false,
    ...overrides,
  }
}

// ─── Fixtures ───────────────────────────────────────────────

const RAW_HTTP_ACTIVE: Aria2RawStatus = {
  gid: '2089b05ecca3d829',
  status: 'active',
  totalLength: '34896138',
  completedLength: '10485760',
  uploadLength: '0',
  downloadSpeed: '15158',
  uploadSpeed: '0',
  connections: '3',
  numSeeders: '0',
  seeder: 'false',
  pieceLength: '1048576',
  numPieces: '34',
  dir: '/tmp/downloads',
  files: [
    {
      index: '1',
      path: '/tmp/downloads/file.zip',
      length: '34896138',
      completedLength: '10485760',
      selected: 'true',
      uris: [{ uri: 'http://example.com/file.zip', status: 'used' }],
    },
  ],
}

const RAW_BT_ACTIVE: Aria2RawStatus = {
  gid: 'a1b2c3d4e5f6a7b8',
  status: 'active',
  totalLength: '104857600',
  completedLength: '52428800',
  uploadLength: '10485760',
  downloadSpeed: '1048576',
  uploadSpeed: '524288',
  connections: '15',
  numSeeders: '8',
  seeder: 'false',
  pieceLength: '262144',
  numPieces: '400',
  dir: '/tmp/downloads',
  files: [],
  bittorrent: {
    announceList: [['http://tracker.example.com/announce']],
    comment: 'A test torrent',
    mode: 'single',
    info: { name: 'ubuntu-24.04.iso' },
  },
  infoHash: 'aabbccddee1122334455',
}

const RAW_METADATA_ACTIVE: Aria2RawStatus = {
  gid: 'ff00ff00ff00ff00',
  status: 'active',
  totalLength: '0',
  completedLength: '0',
  uploadLength: '0',
  downloadSpeed: '512',
  uploadSpeed: '0',
  connections: '1',
  numSeeders: '0',
  seeder: 'false',
  pieceLength: '0',
  numPieces: '0',
  dir: '/tmp/downloads',
  files: [],
  bittorrent: {
    announceList: [],
    mode: 'single',
    info: { name: '' },
  },
}

const RAW_COMPLETED: Aria2RawStatus = {
  ...RAW_HTTP_ACTIVE,
  gid: 'c0c0c0c0c0c0c0c0',
  status: 'complete',
  completedLength: '34896138',
  downloadSpeed: '0',
}

const RAW_ERROR: Aria2RawStatus = {
  ...RAW_HTTP_ACTIVE,
  gid: 'e0e0e0e0e0e0e0e0',
  status: 'error',
  errorCode: '3',
  errorMessage: 'Resource not found',
  downloadSpeed: '0',
}

const RAW_WAITING: Aria2RawStatus = {
  ...RAW_HTTP_ACTIVE,
  gid: 'w0w0w0w0w0w0w0w0',
  status: 'waiting',
  downloadSpeed: '0',
  completedLength: '0',
}

const RAW_PAUSED: Aria2RawStatus = {
  ...RAW_HTTP_ACTIVE,
  gid: 'p0p0p0p0p0p0p0p0',
  status: 'paused',
  downloadSpeed: '0',
}

const RAW_REMOVED: Aria2RawStatus = {
  ...RAW_HTTP_ACTIVE,
  gid: 'r0r0r0r0r0r0r0r0',
  status: 'removed',
  downloadSpeed: '0',
}

const RAW_MAGNET_ACTIVE: Aria2RawStatus = {
  ...RAW_BT_ACTIVE,
  gid: 'm0m0m0m0m0m0m0m0',
  files: [
    {
      index: '1',
      path: '',
      length: '0',
      completedLength: '0',
      selected: 'true',
      uris: [
        {
          uri: 'magnet:?xt=urn:btih:aabb',
          status: 'used',
        },
      ],
    },
  ],
}

const RAW_FTP_ACTIVE: Aria2RawStatus = {
  ...RAW_HTTP_ACTIVE,
  gid: 'f0f0f0f0f0f0f0f0',
  files: [
    {
      index: '1',
      path: '/tmp/downloads/data.bin',
      length: '10000000',
      completedLength: '5000000',
      selected: 'true',
      uris: [
        {
          uri: 'ftp://ftp.example.com/data.bin',
          status: 'used',
        },
      ],
    },
  ],
}

const RAW_GLOBAL_STAT: Aria2RawGlobalStat = {
  downloadSpeed: '15158',
  uploadSpeed: '524',
  numActive: '3',
  numWaiting: '2',
  numStopped: '10',
  numStoppedTotal: '50',
}

const RAW_FILES: Aria2RawFile[] = [
  {
    index: '1',
    path: '/tmp/downloads/file1.txt',
    length: '1048576',
    completedLength: '524288',
    selected: 'true',
    uris: [{ uri: 'http://example.com/file1.txt', status: 'used' }],
  },
  {
    index: '2',
    path: '/tmp/downloads/file2.txt',
    length: '2097152',
    completedLength: '0',
    selected: 'false',
    uris: [],
  },
]

// ─── Tests ──────────────────────────────────────────────────

describe('Aria2Adapter', () => {
  describe('direct resource metadata profile', () => {
    const safeOptions = {
      'content-disposition-default-utf8': 'false',
      'http-accept-gzip': 'true',
      'no-want-digest-header': 'false',
      'no-netrc': 'true',
    }

    it('accepts the controlled HTTP baseline without retaining raw options', async () => {
      await expect(
        directResourceMetadataProfileFromGlobalOptions(safeOptions)
      ).resolves.toBe(DIRECT_RESOURCE_METADATA_PROFILE)

      const rpc = createMockRpc()
      vi.mocked(rpc.getGlobalOption).mockResolvedValue({
        ...safeOptions,
        'all-proxy-passwd': 'must-not-be-cached',
      })
      const adapter = new Aria2Adapter(rpc)
      const profile = await adapter.inspectDirectResourceMetadataProfile()
      adapter.setDirectResourceMetadataProfile(profile)

      expect(adapter.getDirectResourceMetadataProfile()).toBe(
        DIRECT_RESOURCE_METADATA_PROFILE
      )
      expect(adapter).not.toHaveProperty('globalOptions')
    })

    it.each([
      ['header', 'X-Ambient: yes\n'],
      ['referer', 'https://ref.example/'],
      ['load-cookies', '/tmp/cookies.txt'],
      ['http-user', 'alice'],
      ['http-passwd', 'secret'],
      ['conditional-get', 'true'],
      ['dry-run', 'true'],
      ['http-auth-challenge', 'true'],
      ['http-no-cache', 'true'],
      ['use-head', 'true'],
    ])('rejects ambient %s request semantics', async (name, value) => {
      await expect(
        directResourceMetadataProfileFromGlobalOptions({
          ...safeOptions,
          [name]: value,
        })
      ).resolves.toBeNull()
    })

    it('rejects an active netrc but permits the default missing file', async () => {
      const options = {
        ...safeOptions,
        'no-netrc': 'false',
        'netrc-path': '/private/profile/.netrc',
      }
      await expect(
        directResourceMetadataProfileFromGlobalOptions(
          options,
          vi.fn().mockResolvedValue(undefined)
        )
      ).resolves.toBeNull()

      const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
      await expect(
        directResourceMetadataProfileFromGlobalOptions(
          options,
          vi.fn().mockRejectedValue(missing)
        )
      ).resolves.toBe(DIRECT_RESOURCE_METADATA_PROFILE)
    })
  })

  describe('getCapabilities / getFeatureReport', () => {
    it('returns conservative defaults before connect()', () => {
      const rpc = createMockRpc()
      const adapter = new Aria2Adapter(rpc)

      expect(adapter.getCapabilities()).toEqual({
        http: true,
        ftp: true,
        bt: false,
        magnet: false,
        metalink: false,
      })
      expect(adapter.getFeatureReport()).toEqual({
        version: 'unknown',
        features: [],
        hasSqlitePersistence: false,
        hasBtSeedUnverified: false,
        hasBtSaveMetadata: false,
        hasMoveStorage: false,
      })
    })

    it('derives capabilities and feature report from aria2.getVersion on connect (v1.37)', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getVersion).mockResolvedValue({
        version: '1.37.0',
        enabledFeatures: ['BitTorrent', 'Metalink', 'SQLite3-Persistence'],
      })
      const adapter = new Aria2Adapter(rpc)

      await adapter.connect()

      expect(adapter.getCapabilities()).toEqual({
        http: true,
        ftp: true,
        bt: true,
        magnet: true,
        metalink: true,
      })
      expect(adapter.getFeatureReport()).toEqual({
        version: '1.37.0',
        features: ['BitTorrent', 'Metalink', 'SQLite3-Persistence'],
        hasSqlitePersistence: true,
        hasBtSeedUnverified: true,
        hasBtSaveMetadata: true,
        hasMoveStorage: false,
      })
    })

    it('flags hasBtSeedUnverified/hasBtSaveMetadata false on older aria2 (v1.36)', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getVersion).mockResolvedValue({
        version: '1.36.0',
        enabledFeatures: ['BitTorrent'],
      })
      const adapter = new Aria2Adapter(rpc)

      await adapter.connect()

      const report = adapter.getFeatureReport()
      expect(report.version).toBe('1.36.0')
      expect(report.hasBtSeedUnverified).toBe(false)
      expect(report.hasBtSaveMetadata).toBe(false)
      expect(report.hasSqlitePersistence).toBe(false)
      expect(report.hasMoveStorage).toBe(false)
    })

    it('disables bt/magnet/metalink capabilities when aria2 lacks those features', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getVersion).mockResolvedValue({
        version: '1.37.0',
        enabledFeatures: [],
      })
      const adapter = new Aria2Adapter(rpc)

      await adapter.connect()

      expect(adapter.getCapabilities()).toEqual({
        http: true,
        ftp: true,
        bt: false,
        magnet: false,
        metalink: false,
      })
    })

    it('falls back to defaults when getVersion rejects', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getVersion).mockRejectedValue(new Error('rpc offline'))
      const adapter = new Aria2Adapter(rpc)

      await expect(adapter.connect()).resolves.toBeUndefined()

      expect(adapter.getFeatureReport().version).toBe('unknown')
      expect(adapter.getCapabilities().bt).toBe(false)
    })
  })

  describe('createDownload', () => {
    it('pins the metadata-owned baseline and preserves explicit credentials', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('profile-gid')
      const adapter = new Aria2Adapter(rpc)
      adapter.setDirectResourceMetadataProfile(DIRECT_RESOURCE_METADATA_PROFILE)

      await adapter.createDownload({
        uris: ['https://example.com/file'],
        saveDir: '/d',
        headers: { Cookie: 'session=user', authorization: 'Bearer user' },
        directResourceMetadataProfile: DIRECT_RESOURCE_METADATA_PROFILE,
        extraEngineOptions: {
          referer: 'https://user.example/',
          'use-head': 'true',
        },
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['https://example.com/file'],
        expect.objectContaining({
          header: [
            'Cookie: session=user',
            'authorization: Bearer user',
            'Accept: */*',
          ],
          referer: 'https://user.example/',
          'use-head': 'true',
          'http-no-cache': 'false',
          'conditional-get': 'false',
          'no-netrc': 'true',
        })
      )
    })

    it('adds empty Cookie and Authorization only for the safe profile', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('profile-gid')
      const adapter = new Aria2Adapter(rpc)
      adapter.setDirectResourceMetadataProfile(DIRECT_RESOURCE_METADATA_PROFILE)

      await adapter.createDownload({
        uris: ['https://example.com/file'],
        saveDir: '/d',
        directResourceMetadataProfile: DIRECT_RESOURCE_METADATA_PROFILE,
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['https://example.com/file'],
        expect.objectContaining({
          header: ['Cookie: ', 'Authorization: ', 'Accept: */*'],
        })
      )
    })

    it('fails before addUri when the published profile is unavailable', async () => {
      const rpc = createMockRpc()
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.createDownload({
          uris: ['https://example.com/file'],
          saveDir: '/d',
          directResourceMetadataProfile: DIRECT_RESOURCE_METADATA_PROFILE,
        })
      ).rejects.toThrow('request profile changed')
      expect(rpc.addUri).not.toHaveBeenCalled()
    })

    it('translates params and calls addUri', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gid123')
      const adapter = new Aria2Adapter(rpc)

      const params: CreateDownloadParams = {
        uris: ['http://example.com/file.zip'],
        saveDir: '/tmp',
        filename: 'custom.zip',
        dlLimit: 1024,
        ulLimit: 512,
      }

      const gid = await adapter.createDownload(params)

      expect(gid).toBe('gid123')
      expect(rpc.addUri).toHaveBeenCalledWith(['http://example.com/file.zip'], {
        continue: 'false',
        dir: '/tmp',
        header: ['Accept: */*'],
        out: 'custom.zip',
        'max-download-limit': '1024',
        'max-upload-limit': '512',
      })
    })

    it('omits optional fields when not provided', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gid456')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['http://example.com/f.zip'],
        saveDir: '/tmp',
      })

      expect(rpc.addUri).toHaveBeenCalledWith(['http://example.com/f.zip'], {
        continue: 'false',
        dir: '/tmp',
        header: ['Accept: */*'],
      })
    })

    it('maps checkpoint recovery to native checkpoint-only aria2 options', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('checkpoint-gid')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['http://example.com/f.zip'],
        saveDir: '/tmp',
        resumePolicy: 'checkpoint',
        extraEngineOptions: { continue: 'true' },
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['http://example.com/f.zip'],
        expect.objectContaining({
          'always-resume': 'true',
          continue: 'false',
        })
      )
    })

    it('maps sequential-prefix recovery to aria2 continue options', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('prefix-gid')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['http://example.com/f.zip'],
        saveDir: '/tmp',
        resumePolicy: 'sequential-prefix',
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['http://example.com/f.zip'],
        expect.objectContaining({
          'always-resume': 'true',
          continue: 'true',
        })
      )
    })

    it('applies recovery safety options after extra engine options', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('safe-gid')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['http://example.com/f.zip'],
        saveDir: '/tmp',
        resumePolicy: 'sequential-prefix',
        extraEngineOptions: {
          'always-resume': 'false',
          continue: 'false',
        },
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['http://example.com/f.zip'],
        expect.objectContaining({
          'always-resume': 'true',
          continue: 'true',
        })
      )
    })

    it('forces continue off for ordinary new downloads after extra engine options', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('new-gid')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['http://example.com/f.zip'],
        saveDir: '/tmp',
        resumePolicy: 'none',
        extraEngineOptions: { continue: 'true' },
      })

      const options = vi.mocked(rpc.addUri).mock.calls[0][1]
      expect(options).not.toHaveProperty('always-resume')
      expect(options?.continue).toBe('false')
    })

    it('forwards pause:true as aria2 pause option', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gid789')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['http://example.com/p.zip'],
        saveDir: '/tmp',
        pause: true,
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['http://example.com/p.zip'],
        expect.objectContaining({ pause: 'true' })
      )
    })

    it('omits pause option when pause is false or absent', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gid000')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['http://example.com/p.zip'],
        saveDir: '/tmp',
        pause: false,
      })

      const optsArg = vi.mocked(rpc.addUri).mock.calls[0][1] as Record<
        string,
        unknown
      >
      expect(optsArg).not.toHaveProperty('pause')
    })

    it('forwards and verifies a caller-reserved 16-hex gid', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('a1b2c3d4e5f60718')
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.createDownload({
          uris: ['http://example.com/reserved.bin'],
          saveDir: '/tmp',
          gid: 'A1B2C3D4E5F60718',
        })
      ).resolves.toBe('A1B2C3D4E5F60718')
      expect(rpc.addUri).toHaveBeenCalledWith(
        ['http://example.com/reserved.bin'],
        expect.objectContaining({ gid: 'A1B2C3D4E5F60718' })
      )
    })

    it('rejects an invalid caller-reserved gid before addUri', async () => {
      const rpc = createMockRpc()
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.createDownload({
          uris: ['http://example.com/reserved.bin'],
          saveDir: '/tmp',
          gid: 'not-a-valid-gid',
        })
      ).rejects.toThrow('exactly 16 hexadecimal')
      expect(rpc.addUri).not.toHaveBeenCalled()
    })

    it('rejects a mismatched gid returned by addUri', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('0011223344556677')
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.createDownload({
          uris: ['http://example.com/reserved.bin'],
          saveDir: '/tmp',
          gid: 'A1B2C3D4E5F60718',
        })
      ).rejects.toThrow('instead of reserved gid')
    })

    it('createDownload maps connections to split + max-connection-per-server', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['u'],
        saveDir: '/d',
        connections: 8,
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['u'],
        expect.objectContaining({
          split: '8',
          'max-connection-per-server': '8',
        })
      )
    })

    it('pre-caps connection options after the shell detects official aria2', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)
      adapter.setFeatureReport(
        featureReport({
          version: '1.37.0',
          features: [],
          hasSqlitePersistence: false,
        })
      )

      await adapter.createDownload({
        uris: ['u'],
        saveDir: '/d',
        connections: 64,
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['u'],
        expect.objectContaining({
          split: '16',
          'max-connection-per-server': '16',
        })
      )
    })

    it('preserves high connection options for the Motrix fork', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)
      adapter.setFeatureReport(featureReport())

      await adapter.createDownload({
        uris: ['u'],
        saveDir: '/d',
        connections: 64,
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['u'],
        expect.objectContaining({
          split: '64',
          'max-connection-per-server': '64',
        })
      )
    })

    it('retries errorCode=28 once at 16 and remembers the discovered limit', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri)
        .mockRejectedValueOnce(
          new Error(
            'errorCode=28: max-connection-per-server must be between 1 and 16'
          )
        )
        .mockResolvedValueOnce('gid-first')
        .mockResolvedValueOnce('gid-second')
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.createDownload({
          uris: ['first'],
          saveDir: '/d',
          connections: 64,
        })
      ).resolves.toBe('gid-first')
      await adapter.createDownload({
        uris: ['second'],
        saveDir: '/d',
        connections: 64,
      })

      expect(rpc.addUri).toHaveBeenNthCalledWith(
        1,
        ['first'],
        expect.objectContaining({
          split: '64',
          'max-connection-per-server': '64',
        })
      )
      expect(rpc.addUri).toHaveBeenNthCalledWith(
        2,
        ['first'],
        expect.objectContaining({
          split: '16',
          'max-connection-per-server': '16',
        })
      )
      expect(rpc.addUri).toHaveBeenNthCalledWith(
        3,
        ['second'],
        expect.objectContaining({
          split: '16',
          'max-connection-per-server': '16',
        })
      )
    })

    it('does not retry unrelated addUri failures', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockRejectedValue(new Error('connection refused'))
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.createDownload({
          uris: ['u'],
          saveDir: '/d',
          connections: 64,
        })
      ).rejects.toThrow('connection refused')
      expect(rpc.addUri).toHaveBeenCalledOnce()
    })

    it('auto profile applies per-file tuning without sending global disk-cache', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['u'],
        saveDir: '/d',
        performanceProfile: 'auto',
        protocol: 'http',
        totalSizeBytes: 10 * 1024 * 1024 * 1024,
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['u'],
        expect.objectContaining({
          split: '32',
          'min-split-size': String(10 * 1024 * 1024),
        })
      )
      const options = vi.mocked(rpc.addUri).mock.calls[0][1]
      expect(options).not.toHaveProperty('disk-cache')
    })

    it('fixed profiles keep their global tuning values', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['u'],
        saveDir: '/d',
        performanceProfile: 'high',
        protocol: 'http',
        totalSizeBytes: 10 * 1024 * 1024 * 1024,
      })

      expect(rpc.addUri).toHaveBeenCalledWith(['u'], {
        continue: 'false',
        dir: '/d',
      })
    })

    it('auto tuning preserves an explicit connection count', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['u'],
        saveDir: '/d',
        performanceProfile: 'auto',
        protocol: 'http',
        totalSizeBytes: 10 * 1024 * 1024 * 1024,
        connections: 8,
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['u'],
        expect.objectContaining({
          split: '8',
          'max-connection-per-server': '8',
        })
      )
    })

    it('createDownload maps proxy to all-proxy and merges extraEngineOptions', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['u'],
        saveDir: '/d',
        proxy: 'http://a%40b:p%3As@p:1080',
        extraEngineOptions: { referer: 'https://r', 'load-cookies': '/c' },
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['u'],
        expect.objectContaining({
          'all-proxy': 'http://p:1080',
          'all-proxy-user': 'a@b',
          'all-proxy-passwd': 'p:s',
          referer: 'https://r',
          'load-cookies': '/c',
        })
      )
      const proxy = vi.mocked(rpc.addUri).mock.calls[0]?.[1]?.['all-proxy']
      expect(proxy).not.toContain('a%40b')
      expect(proxy).not.toContain('p%3As')
    })

    it('pins the captured engine User-Agent as a per-task option', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['u'],
        saveDir: '/d',
        userAgent: 'Motrix/Applied',
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['u'],
        expect.objectContaining({ 'user-agent': 'Motrix/Applied' })
      )
    })

    it('pins the default HTTP Accept header against Metalink negotiation', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['https://downloads.example/release'],
        saveDir: '/d',
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['https://downloads.example/release'],
        expect.objectContaining({ header: ['Accept: */*'] })
      )
    })

    it('pins the default Accept header for uppercase HTTP schemes', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['HTTPS://downloads.example/release'],
        saveDir: '/d',
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['HTTPS://downloads.example/release'],
        expect.objectContaining({ header: ['Accept: */*'] })
      )
    })

    it('preserves a task-provided Accept header', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['https://downloads.example/release'],
        saveDir: '/d',
        headers: { aCcEpT: 'application/octet-stream' },
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['https://downloads.example/release'],
        expect.objectContaining({
          header: ['aCcEpT: application/octet-stream'],
        })
      )
    })

    it('pins an explicitly empty engine User-Agent', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['u'],
        saveDir: '/d',
        userAgent: '',
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['u'],
        expect.objectContaining({ 'user-agent': '' })
      )
    })

    it('rejects a task User-Agent containing persistent option controls', async () => {
      const rpc = createMockRpc()
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.createDownload({
          uris: ['u'],
          saveDir: '/d',
          userAgent: 'Motrix\nall-proxy=http://evil',
        })
      ).rejects.toThrow('Task User-Agent must not contain control characters')
      expect(rpc.addUri).not.toHaveBeenCalled()
    })

    it('clears inherited global credentials for an unauthenticated task proxy', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['u'],
        saveDir: '/d',
        proxy: 'proxy.example:1080',
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['u'],
        expect.objectContaining({
          'all-proxy': 'proxy.example:1080',
          'all-proxy-user': '',
          'all-proxy-passwd': '',
        })
      )
    })

    it('preserves an aria2-compatible legacy IPv4 task proxy', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addUri).mockResolvedValue('gidXYZ')
      const adapter = new Aria2Adapter(rpc)

      await adapter.createDownload({
        uris: ['u'],
        saveDir: '/d',
        proxy: 'http://user:pass@127.1:8080',
      })

      expect(rpc.addUri).toHaveBeenCalledWith(
        ['u'],
        expect.objectContaining({
          'all-proxy': 'http://127.1:8080',
          'all-proxy-user': 'user',
          'all-proxy-passwd': 'pass',
        })
      )
    })

    it('rejects passthrough options that could override the applied proxy route', async () => {
      const rpc = createMockRpc()
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.createDownload({
          uris: ['u'],
          saveDir: '/d',
          extraEngineOptions: { 'http-proxy': 'http://other:8080' },
        })
      ).rejects.toThrow('Reserved aria2 proxy option')
      expect(rpc.addUri).not.toHaveBeenCalled()
    })

    it.each(['socks5://proxy.example:1080', 'http://proxy.example:8080/path'])(
      'rejects an unsupported task proxy before RPC: %s',
      async (proxy) => {
        const rpc = createMockRpc()
        const adapter = new Aria2Adapter(rpc)

        await expect(
          adapter.createDownload({ uris: ['u'], saveDir: '/d', proxy })
        ).rejects.toThrow('Task proxy must use aria2-compatible HTTP or HTTPS')
        expect(rpc.addUri).not.toHaveBeenCalled()
      }
    )

    it('rejects decoded control characters before aria2 persists task options', async () => {
      const rpc = createMockRpc()
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.createDownload({
          uris: ['u'],
          saveDir: '/d',
          proxy:
            'http://user%0Ahttp-proxy%3Dhttp%3A%2F%2Fevil:pass@proxy.example:8080',
        })
      ).rejects.toThrow('Unsupported aria2 proxy credentials')
      expect(rpc.addUri).not.toHaveBeenCalled()
    })
  })

  describe('pauseTask', () => {
    it('delegates to rpc.pause', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.pause).mockResolvedValue('gid1')
      const adapter = new Aria2Adapter(rpc)

      await adapter.pauseTask('gid1')
      expect(rpc.pause).toHaveBeenCalledWith('gid1')
    })
  })

  describe('resumeTask', () => {
    it('delegates to rpc.unpause', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.unpause).mockResolvedValue('gid1')
      const adapter = new Aria2Adapter(rpc)

      await adapter.resumeTask('gid1')
      expect(rpc.unpause).toHaveBeenCalledWith('gid1')
    })
  })

  describe('removeTask', () => {
    it('delegates to rpc.remove', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.remove).mockResolvedValue('gid1')
      const adapter = new Aria2Adapter(rpc)

      await adapter.removeTask('gid1')
      expect(rpc.remove).toHaveBeenCalledWith('gid1')
    })
  })

  describe('forceRemoveTask', () => {
    it('delegates to rpc.forceRemove', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.forceRemove).mockResolvedValue('gid1')
      const adapter = new Aria2Adapter(rpc)

      await adapter.forceRemoveTask('gid1')
      expect(rpc.forceRemove).toHaveBeenCalledWith('gid1')
    })

    it('absorbs an already-evicted gid (aria2 "is not found")', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.forceRemove).mockRejectedValue(
        new Error('GID gid1 is not found')
      )
      const adapter = new Aria2Adapter(rpc)

      await expect(adapter.forceRemoveTask('gid1')).resolves.toBeUndefined()
    })

    it('rethrows non-not-found engine errors', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.forceRemove).mockRejectedValue(new Error('rpc timeout'))
      const adapter = new Aria2Adapter(rpc)

      await expect(adapter.forceRemoveTask('gid1')).rejects.toThrow(
        'rpc timeout'
      )
    })
  })

  describe('getTaskStatus — status translation', () => {
    it('translates active HTTP download', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(RAW_HTTP_ACTIVE)
      const adapter = new Aria2Adapter(rpc)

      const task = await adapter.getTaskStatus('2089b05ecca3d829')

      expect(task).not.toBeNull()
      expect(task?.engineTaskId).toBe('2089b05ecca3d829')
      expect(task?.status).toBe('downloading')
      expect(task?.type).toBe('http')
      expect(task?.totalBytes).toBe(34896138)
      expect(task?.downloadedBytes).toBe(10485760)
      expect(task?.downloadSpeed).toBe(15158)
      expect(task?.uploadSpeed).toBe(0)
      expect(task?.connections).toBe(3)
      expect(task?.saveDir).toBe('/tmp/downloads')
      expect(task?.progress).toBeCloseTo(0.3005, 3)
    })

    it('translates active BT download with bittorrent info', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(RAW_BT_ACTIVE)
      const adapter = new Aria2Adapter(rpc)

      const task = await adapter.getTaskStatus('a1b2c3d4e5f6a7b8')

      expect(task?.type).toBe('bt')
      expect(task?.name).toBe('ubuntu-24.04.iso')
      expect(task?.infoHash).toBe('aabbccddee1122334455')
      expect(task?.bt).toBeDefined()
      expect(task?.bt?.seeds).toBe(8)
      expect(task?.bt?.comment).toBe('A test torrent')
      expect(task?.bt?.announceList).toEqual([
        ['http://tracker.example.com/announce'],
      ])
    })

    it('translates active with totalLength=0 as FetchingMetadata', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(RAW_METADATA_ACTIVE)
      const adapter = new Aria2Adapter(rpc)

      const task = await adapter.getTaskStatus('ff00ff00ff00ff00')

      expect(task?.status).toBe('fetching_metadata')
    })

    it('translates waiting status as Queued', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(RAW_WAITING)
      const adapter = new Aria2Adapter(rpc)

      const task = await adapter.getTaskStatus('w0w0w0w0w0w0w0w0')
      expect(task?.status).toBe('queued')
    })

    it('translates complete status as Completed', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(RAW_COMPLETED)
      const adapter = new Aria2Adapter(rpc)

      const task = await adapter.getTaskStatus('c0c0c0c0c0c0c0c0')
      expect(task?.status).toBe('completed')
      expect(task?.progress).toBe(1)
    })

    it('translates error status with error details', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(RAW_ERROR)
      const adapter = new Aria2Adapter(rpc)

      const task = await adapter.getTaskStatus('e0e0e0e0e0e0e0e0')
      expect(task?.status).toBe('error')
      expect(task?.errorMessage).toBe('Resource not found')
    })

    it('translates paused status', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(RAW_PAUSED)
      const adapter = new Aria2Adapter(rpc)

      const task = await adapter.getTaskStatus('p0p0p0p0p0p0p0p0')
      expect(task?.status).toBe('paused')
    })

    it('translates removed status', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(RAW_REMOVED)
      const adapter = new Aria2Adapter(rpc)

      const task = await adapter.getTaskStatus('r0r0r0r0r0r0r0r0')
      expect(task?.status).toBe('removed')
    })

    it('detects magnet type from URI', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(RAW_MAGNET_ACTIVE)
      const adapter = new Aria2Adapter(rpc)

      const task = await adapter.getTaskStatus('m0m0m0m0m0m0m0m0')
      expect(task?.type).toBe('magnet')
    })

    it('detects ftp type from URI', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(RAW_FTP_ACTIVE)
      const adapter = new Aria2Adapter(rpc)

      const task = await adapter.getTaskStatus('f0f0f0f0f0f0f0f0')
      expect(task?.type).toBe('ftp')
    })

    it('computes ETA correctly for active download', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(RAW_HTTP_ACTIVE)
      const adapter = new Aria2Adapter(rpc)

      const task = await adapter.getTaskStatus('2089b05ecca3d829')
      // remaining = 34896138 - 10485760 = 24410378
      // eta = 24410378 / 15158 ≈ 1610 seconds
      expect(task?.etaSeconds).toBeCloseTo(1610, -1)
    })

    it('sets ETA to 0 when speed is 0', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(RAW_COMPLETED)
      const adapter = new Aria2Adapter(rpc)

      const task = await adapter.getTaskStatus('c0c0c0c0c0c0c0c0')
      expect(task?.etaSeconds).toBe(0)
    })

    it('detects seeding status for BT downloads', async () => {
      const rpc = createMockRpc()
      const seedingRaw: Aria2RawStatus = {
        ...RAW_BT_ACTIVE,
        gid: 's0s0s0s0s0s0s0s0',
        seeder: 'true',
        completedLength: '104857600',
      }
      vi.mocked(rpc.tellStatus).mockResolvedValue(seedingRaw)
      const adapter = new Aria2Adapter(rpc)

      const task = await adapter.getTaskStatus('s0s0s0s0s0s0s0s0')
      expect(task?.status).toBe('seeding')
    })
  })

  describe('getTaskFiles', () => {
    it('translates raw files to TaskFile array', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getFiles).mockResolvedValue(RAW_FILES)
      const adapter = new Aria2Adapter(rpc)

      const files = await adapter.getTaskFiles('gid1')

      expect(files).toHaveLength(2)
      expect(files[0]).toEqual({
        index: 0,
        path: '/tmp/downloads/file1.txt',
        size: 1048576,
        completedBytes: 524288,
        selected: true,
      })
      expect(files[1]).toEqual({
        index: 1,
        path: '/tmp/downloads/file2.txt',
        size: 2097152,
        completedBytes: 0,
        selected: false,
      })
    })
  })

  describe('getTaskPieces', () => {
    it('returns parsed piece state for an engine-backed task', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue({
        pieceLength: '16384',
        numPieces: '8',
        bitfield: 'ff',
      } as unknown as Aria2RawStatus)
      const adapter = new Aria2Adapter(rpc)

      const result = await adapter.getTaskPieces('gid-1')

      expect(result).toEqual({
        pieceLength: 16384,
        numPieces: 8,
        bitfield: 'ff',
      })
      expect(rpc.tellStatus).toHaveBeenCalledWith('gid-1', [
        'pieceLength',
        'numPieces',
        'bitfield',
      ])
    })

    it('normalizes missing piece fields to zero-shape', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(
        {} as unknown as Aria2RawStatus
      )
      const adapter = new Aria2Adapter(rpc)

      const result = await adapter.getTaskPieces('gid-2')
      expect(result).toEqual({ pieceLength: 0, numPieces: 0, bitfield: '' })
    })

    it('returns null when aria2 reports unknown gid', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockRejectedValue(new Error('GID not found'))
      const adapter = new Aria2Adapter(rpc)

      const result = await adapter.getTaskPieces('missing')
      expect(result).toBeNull()
    })
  })

  describe('getGlobalStats', () => {
    it('translates raw global stat to GlobalStats', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getGlobalStat).mockResolvedValue(RAW_GLOBAL_STAT)
      const adapter = new Aria2Adapter(rpc)

      const stats = await adapter.getGlobalStats()

      expect(stats).toEqual({
        totalDownloadSpeed: 15158,
        totalUploadSpeed: 524,
        activeTasks: 3,
        waitingTasks: 2,
        stoppedTasks: 10,
      })
    })
  })

  describe('pauseAll', () => {
    it('delegates to rpcClient.pauseAll', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.pauseAll).mockResolvedValue('OK')
      const adapter = new Aria2Adapter(rpc)
      await adapter.pauseAll()
      expect(rpc.pauseAll).toHaveBeenCalledOnce()
    })
  })

  describe('resumeAll', () => {
    it('delegates to rpcClient.unpauseAll', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.unpauseAll).mockResolvedValue('OK')
      const adapter = new Aria2Adapter(rpc)
      await adapter.resumeAll()
      expect(rpc.unpauseAll).toHaveBeenCalledOnce()
    })
  })

  describe('changePosition', () => {
    it('forwards gid, pos, and how to rpcClient', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.changePosition).mockResolvedValue(5)
      const adapter = new Aria2Adapter(rpc)
      const result = await adapter.changePosition('gid-1', -1, 'POS_CUR')
      expect(rpc.changePosition).toHaveBeenCalledWith('gid-1', -1, 'POS_CUR')
      expect(result).toBe(5)
    })
  })

  describe('addTorrent', () => {
    it('calls aria2.addTorrent with base64 metadata and options', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addTorrent).mockResolvedValue('gid-new')
      const adapter = new Aria2Adapter(rpc)
      const bytes = new Uint8Array([1, 2, 3, 4])

      const gid = await adapter.addTorrent({
        metadata: bytes,
        saveDir: '/d',
        selectedFiles: [1, 3],
        seedTime: 60,
        seedRatio: 1.0,
        btSeedUnverified: true,
        pause: false,
      })

      expect(gid).toBe('gid-new')
      const call = vi.mocked(rpc.addTorrent).mock.calls[0]
      expect(call).toBeDefined()
      const [b64, uris, opts] = call as [
        string,
        string[],
        Record<string, string>,
      ]
      expect(b64).toBe(Buffer.from(bytes).toString('base64'))
      expect(uris).toEqual([])
      expect(opts).toEqual({
        dir: '/d',
        'select-file': '1,3',
        'seed-time': '60',
        'seed-ratio': '1',
        'bt-seed-unverified': 'true',
        pause: 'false',
      })
    })

    it('omits select-file when selectedFiles is undefined', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addTorrent).mockResolvedValue('g')
      const adapter = new Aria2Adapter(rpc)

      await adapter.addTorrent({
        metadata: new Uint8Array([0]),
        saveDir: '/d',
      })

      const call = vi.mocked(rpc.addTorrent).mock.calls[0]
      expect(call).toBeDefined()
      const [, , opts] = call as [string, string[], Record<string, string>]
      expect(opts).not.toHaveProperty('select-file')
    })

    it('maps preview piece priority only when requested by the product layer', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addTorrent).mockResolvedValue('g')
      const adapter = new Aria2Adapter(rpc)

      await adapter.addTorrent({
        metadata: new Uint8Array([0]),
        saveDir: '/d',
        prioritizePreviewPieces: true,
      })

      const [, , opts] = vi.mocked(rpc.addTorrent).mock.calls[0] as [
        string,
        string[],
        Record<string, string>,
      ]
      expect(opts['bt-prioritize-piece']).toBe('head=10M,tail=10M')
    })

    it('maps zero-based output paths to repeated aria2 index-out options', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addTorrent).mockResolvedValue('g')
      const adapter = new Aria2Adapter(rpc)

      await adapter.addTorrent({
        metadata: new Uint8Array([0]),
        saveDir: '/d/.motrix/abc',
        outputFilePaths: [
          { fileIndex: 0, relativePath: 'p/movie.mkv' },
          { fileIndex: 2, relativePath: 'p/sub/readme.txt' },
        ],
      })

      const [, , opts] = vi.mocked(rpc.addTorrent).mock.calls[0] as [
        string,
        string[],
        Record<string, string | string[]>,
      ]
      expect(opts['index-out']).toEqual(['1=p/movie.mkv', '3=p/sub/readme.txt'])
    })

    it('rejects traversal in an output file mapping before RPC dispatch', async () => {
      const rpc = createMockRpc()
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.addTorrent({
          metadata: new Uint8Array([0]),
          saveDir: '/d',
          outputFilePaths: [{ fileIndex: 0, relativePath: '../escape' }],
        })
      ).rejects.toThrow('Invalid torrent output file mapping')
      expect(rpc.addTorrent).not.toHaveBeenCalled()
    })

    it('forwards and returns a caller-reserved 16-hex gid', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addTorrent).mockResolvedValue('a1b2c3d4e5f60718')
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.addTorrent({
          metadata: new Uint8Array([0]),
          saveDir: '/d',
          gid: 'A1B2C3D4E5F60718',
        })
      ).resolves.toBe('A1B2C3D4E5F60718')
      expect(rpc.addTorrent).toHaveBeenCalledWith(
        expect.any(String),
        [],
        expect.objectContaining({ gid: 'A1B2C3D4E5F60718' })
      )
    })

    it('rejects an invalid caller gid before dispatching engine work', async () => {
      const rpc = createMockRpc()
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.addTorrent({
          metadata: new Uint8Array([0]),
          saveDir: '/d',
          gid: 'not-a-valid-gid',
        })
      ).rejects.toThrow('exactly 16 hexadecimal')
      expect(rpc.addTorrent).not.toHaveBeenCalled()
    })

    it('propagates RPC errors', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addTorrent).mockRejectedValue(new Error('rpc down'))
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.addTorrent({
          metadata: new Uint8Array([0]),
          saveDir: '/d',
        })
      ).rejects.toThrow('rpc down')
    })

    it('addTorrent maps dlLimit/ulLimit with K suffix and merges extraEngineOptions', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addTorrent).mockResolvedValue('gid')
      const adapter = new Aria2Adapter(rpc)
      await adapter.addTorrent({
        metadata: new Uint8Array(),
        saveDir: '/d',
        dlLimit: 100,
        ulLimit: 50,
        extraEngineOptions: { 'bt-max-peers': '60' },
      })
      expect(rpc.addTorrent).toHaveBeenCalledWith(
        expect.any(String),
        [],
        expect.objectContaining({
          'max-download-limit': '100K',
          'max-upload-limit': '50K',
          'bt-max-peers': '60',
        })
      )
    })

    it('rejects torrent passthrough options that could override the proxy route', async () => {
      const rpc = createMockRpc()
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.addTorrent({
          metadata: new Uint8Array(),
          saveDir: '/d',
          extraEngineOptions: { 'no-proxy': 'attacker.example' },
        })
      ).rejects.toThrow('Reserved aria2 proxy option')
      expect(rpc.addTorrent).not.toHaveBeenCalled()
    })

    it('passes selectedFiles through as-is (index-neutral raw join)', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addTorrent).mockResolvedValue('gid')
      const adapter = new Aria2Adapter(rpc)
      await adapter.addTorrent({
        metadata: new Uint8Array([0]),
        saveDir: '/d',
        selectedFiles: [2, 5],
      })
      const [, , opts] = vi.mocked(rpc.addTorrent).mock.calls[0] as [
        string,
        string[],
        Record<string, string>,
      ]
      expect(opts['select-file']).toBe('2,5')
    })
  })

  describe('removeDownloadResults (batch)', () => {
    it('sends one multicall with the gids in array order', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.multicallSettled).mockResolvedValue([
        { status: 'fulfilled', value: 'OK' },
        { status: 'fulfilled', value: 'OK' },
      ])
      const adapter = new Aria2Adapter(rpc)

      const settled = await adapter.removeDownloadResults(['gid-1', 'gid-2'])

      expect(rpc.multicallSettled).toHaveBeenCalledExactlyOnceWith([
        { method: 'aria2.removeDownloadResult', params: ['gid-1'] },
        { method: 'aria2.removeDownloadResult', params: ['gid-2'] },
      ])
      expect(settled).toEqual([
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined },
      ])
    })

    it('maps a per-entry GID not-found fault to fulfilled (idempotent contract)', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.multicallSettled).mockResolvedValue([
        { status: 'rejected', reason: new Error('GID gid-1 is not found') },
        { status: 'rejected', reason: new Error('Unauthorized') },
      ])
      const adapter = new Aria2Adapter(rpc)

      const settled = await adapter.removeDownloadResults(['gid-1', 'gid-2'])

      expect(settled[0]).toEqual({ status: 'fulfilled', value: undefined })
      expect(settled[1]).toEqual({
        status: 'rejected',
        reason: expect.any(Error),
      })
    })

    it('keeps not-found rejected on pre-.3 persistent forks (untrusted absence)', async () => {
      // 1.37.0-motrix.1/.2 with sqlite3 persistence report BOTH evicted-but-
      // persisted gids AND failed persistent deletes as "is not found".
      // Treating that as removed lets clearStoppedTasks erase local records
      // while the durable engine row survives and resurrects as an orphan.
      const rpc = createMockRpc()
      vi.mocked(rpc.getVersion).mockResolvedValue({
        version: '1.37.0-motrix.2',
        enabledFeatures: ['BitTorrent', 'SQLite3-Persistence'],
      })
      vi.mocked(rpc.multicallSettled).mockResolvedValue([
        { status: 'rejected', reason: new Error('GID gid-1 is not found') },
      ])
      const adapter = new Aria2Adapter(rpc)
      await adapter.connect()

      const settled = await adapter.removeDownloadResults(['gid-1'])

      expect(settled[0]).toEqual({
        status: 'rejected',
        reason: expect.any(Error),
      })
    })

    it('trusts not-found as durably absent on 1.37.0-motrix.3+', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getVersion).mockResolvedValue({
        version: '1.37.0-motrix.3',
        enabledFeatures: ['BitTorrent', 'SQLite3-Persistence'],
      })
      vi.mocked(rpc.multicallSettled).mockResolvedValue([
        { status: 'rejected', reason: new Error('GID gid-1 is not found') },
      ])
      const adapter = new Aria2Adapter(rpc)
      await adapter.connect()

      const settled = await adapter.removeDownloadResults(['gid-1'])

      expect(settled[0]).toEqual({ status: 'fulfilled', value: undefined })
    })

    it('chunks large batches into sequential bounded multicalls', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.multicallSettled).mockImplementation(async (calls) =>
        calls.map(() => ({ status: 'fulfilled' as const, value: 'OK' }))
      )
      const adapter = new Aria2Adapter(rpc)
      const gids = Array.from({ length: 250 }, (_, i) => `gid-${i}`)

      const settled = await adapter.removeDownloadResults(gids)

      // One unbounded multicall must round-trip inside the protocol's fixed
      // timeout; a million-row history cannot. 100-entry chunks keep every
      // request small while preserving array order across chunks.
      const batches = vi.mocked(rpc.multicallSettled).mock.calls
      expect(batches.map((call) => call[0].length)).toEqual([100, 100, 50])
      expect(batches[0]?.[0]?.[0]).toEqual({
        method: 'aria2.removeDownloadResult',
        params: ['gid-0'],
      })
      expect(batches[2]?.[0]?.[49]).toEqual({
        method: 'aria2.removeDownloadResult',
        params: ['gid-249'],
      })
      expect(settled).toHaveLength(250)
      expect(settled.every((entry) => entry.status === 'fulfilled')).toBe(true)
    })

    it('a chunk-level RPC failure rejects that chunk and the rest, without throwing', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.multicallSettled)
        .mockImplementationOnce(async (calls) =>
          calls.map(() => ({ status: 'fulfilled' as const, value: 'OK' }))
        )
        .mockRejectedValueOnce(new Error('request timed out'))
      const adapter = new Aria2Adapter(rpc)
      const gids = Array.from({ length: 250 }, (_, i) => `gid-${i}`)

      const settled = await adapter.removeDownloadResults(gids)

      // Confirmed cleanups from the first chunk survive; everything from the
      // failed chunk onward is reported rejected instead of stacking further
      // timeouts against an unresponsive engine.
      expect(vi.mocked(rpc.multicallSettled)).toHaveBeenCalledTimes(2)
      expect(settled).toHaveLength(250)
      expect(
        settled.slice(0, 100).every((entry) => entry.status === 'fulfilled')
      ).toBe(true)
      expect(
        settled.slice(100).every((entry) => entry.status === 'rejected')
      ).toBe(true)
    })

    it('a truncated multicall response rejects that whole chunk', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.multicallSettled).mockResolvedValue([
        { status: 'fulfilled', value: 'OK' },
      ])
      const adapter = new Aria2Adapter(rpc)

      const settled = await adapter.removeDownloadResults(['gid-1', 'gid-2'])

      expect(settled).toHaveLength(2)
      expect(settled.every((entry) => entry.status === 'rejected')).toBe(true)
    })

    it('short-circuits an empty batch without an engine round-trip', async () => {
      const rpc = createMockRpc()
      const adapter = new Aria2Adapter(rpc)

      await expect(adapter.removeDownloadResults([])).resolves.toEqual([])
      expect(rpc.multicallSettled).not.toHaveBeenCalled()
    })
  })

  describe('removeDownloadResult', () => {
    it('calls aria2.removeDownloadResult', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.removeDownloadResult).mockResolvedValue('OK')
      const adapter = new Aria2Adapter(rpc)

      await adapter.removeDownloadResult('gid-1')
      expect(rpc.removeDownloadResult).toHaveBeenCalledWith('gid-1')
    })

    it('swallows an explicit aria2 GID not-found error (idempotent)', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.removeDownloadResult).mockRejectedValue(
        new Error('GID gid-1 is not found')
      )
      const adapter = new Aria2Adapter(rpc)

      await expect(
        adapter.removeDownloadResult('gid-1')
      ).resolves.toBeUndefined()
    })

    it.each([
      new Error('socket disconnected'),
      new Error('JSON-RPC call timed out'),
      new Error('JSON-RPC method is not found'),
    ])('propagates non-GID cleanup failures: %s', async (error) => {
      const rpc = createMockRpc()
      vi.mocked(rpc.removeDownloadResult).mockRejectedValue(error)
      const adapter = new Aria2Adapter(rpc)

      await expect(adapter.removeDownloadResult('gid-1')).rejects.toBe(error)
    })

    it('rethrows not-found on a pre-.3 persistent fork (untrusted absence)', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getVersion).mockResolvedValue({
        version: '1.37.0-motrix.2',
        enabledFeatures: ['SQLite3-Persistence'],
      })
      vi.mocked(rpc.removeDownloadResult).mockRejectedValue(
        new Error('GID gid-1 is not found')
      )
      const adapter = new Aria2Adapter(rpc)
      await adapter.connect()

      await expect(adapter.removeDownloadResult('gid-1')).rejects.toThrow(
        /not found/i
      )
    })

    it('swallows not-found on 1.37.0-motrix.3+ (durable-absent contract)', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getVersion).mockResolvedValue({
        version: '1.37.0-motrix.3',
        enabledFeatures: ['SQLite3-Persistence'],
      })
      vi.mocked(rpc.removeDownloadResult).mockRejectedValue(
        new Error('GID gid-1 is not found')
      )
      const adapter = new Aria2Adapter(rpc)
      await adapter.connect()

      await expect(
        adapter.removeDownloadResult('gid-1')
      ).resolves.toBeUndefined()
    })
  })

  describe('getUploadLength', () => {
    it('returns uploadLength from tellStatus', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue({
        uploadLength: '2048',
      } as unknown as Aria2RawStatus)
      const adapter = new Aria2Adapter(rpc)

      expect(await adapter.getUploadLength('g')).toBe(2048)
      expect(rpc.tellStatus).toHaveBeenCalledWith('g', ['uploadLength'])
    })

    it('returns 0 when task not found', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockRejectedValue({
        code: 1,
        message: 'GID not found',
      })
      const adapter = new Aria2Adapter(rpc)

      expect(await adapter.getUploadLength('g')).toBe(0)
    })

    it('returns 0 when uploadLength is missing', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStatus).mockResolvedValue(
        {} as unknown as Aria2RawStatus
      )
      const adapter = new Aria2Adapter(rpc)

      expect(await adapter.getUploadLength('g')).toBe(0)
    })
  })

  describe('listActiveAndWaiting', () => {
    it('merges tellActive and tellWaiting, maps entries', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellActive).mockResolvedValue([
        { gid: 'a1', infoHash: 'hashA' },
        { gid: 'a2' },
      ] as unknown as Aria2RawStatus[])
      vi.mocked(rpc.tellWaiting).mockResolvedValue([
        { gid: 'w1', infoHash: 'hashW' },
      ] as unknown as Aria2RawStatus[])
      const adapter = new Aria2Adapter(rpc)

      const result = await adapter.listActiveAndWaiting()

      expect(rpc.tellActive).toHaveBeenCalledWith(['gid', 'infoHash'])
      expect(rpc.tellWaiting).toHaveBeenCalledWith(0, 1000, ['gid', 'infoHash'])
      expect(result).toEqual([
        { gid: 'a1', infoHash: 'hashA' },
        { gid: 'a2', infoHash: undefined },
        { gid: 'w1', infoHash: 'hashW' },
      ])
    })

    it('maps empty infoHash string to undefined', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellActive).mockResolvedValue([
        { gid: 'a1', infoHash: '' },
      ] as unknown as Aria2RawStatus[])
      vi.mocked(rpc.tellWaiting).mockResolvedValue(
        [] as unknown as Aria2RawStatus[]
      )
      const adapter = new Aria2Adapter(rpc)

      const result = await adapter.listActiveAndWaiting()
      expect(result).toEqual([{ gid: 'a1', infoHash: undefined }])
    })
  })

  describe('listStopped', () => {
    it('calls tellStopped and maps entries', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.tellStopped).mockResolvedValue([
        { gid: 's1', infoHash: 'hashS' },
        { gid: 's2' },
      ] as unknown as Aria2RawStatus[])
      const adapter = new Aria2Adapter(rpc)

      const result = await adapter.listStopped()

      expect(rpc.tellStopped).toHaveBeenCalledWith(0, 1000, ['gid', 'infoHash'])
      expect(result).toEqual([
        { gid: 's1', infoHash: 'hashS' },
        { gid: 's2', infoHash: undefined },
      ])
    })
  })

  describe('onBtDownloadComplete', () => {
    it('disposes RPC producers and local subscribers idempotently', () => {
      const rpc = createMockRpc()
      const unsubscribeBt = vi.fn()
      const unsubscribeDownload = vi.fn()
      const unsubscribeError = vi.fn()
      let emitBt: ((event: { gid: string }) => void) | undefined
      vi.mocked(rpc.onBtDownloadComplete).mockImplementation((handler) => {
        emitBt = handler
        return unsubscribeBt
      })
      vi.mocked(rpc.onDownloadComplete).mockReturnValue(unsubscribeDownload)
      vi.mocked(rpc.onDownloadError).mockReturnValue(unsubscribeError)
      const adapter = new Aria2Adapter(rpc)
      const handler = vi.fn()
      adapter.onBtDownloadComplete(handler)

      adapter.dispose()
      adapter.dispose()
      emitBt?.({ gid: 'late-gid' })

      expect(unsubscribeBt).toHaveBeenCalledTimes(1)
      expect(unsubscribeDownload).toHaveBeenCalledTimes(1)
      expect(unsubscribeError).toHaveBeenCalledTimes(1)
      expect(handler).not.toHaveBeenCalled()
    })

    it('attempts every RPC unsubscribe when one producer throws', () => {
      const rpc = createMockRpc()
      const unsubscribeDownload = vi.fn()
      const unsubscribeError = vi.fn()
      vi.mocked(rpc.onBtDownloadComplete).mockReturnValue(() => {
        throw new Error('unsubscribe failed')
      })
      vi.mocked(rpc.onDownloadComplete).mockReturnValue(unsubscribeDownload)
      vi.mocked(rpc.onDownloadError).mockReturnValue(unsubscribeError)
      const adapter = new Aria2Adapter(rpc)

      expect(() => adapter.dispose()).toThrow('unsubscribe failed')

      expect(unsubscribeDownload).toHaveBeenCalledOnce()
      expect(unsubscribeError).toHaveBeenCalledOnce()
      expect(() => adapter.dispose()).not.toThrow()
    })

    it('forwards gid from aria2.onBtDownloadComplete notifications', () => {
      const rpc = createMockRpc()
      const captor: { fn?: (event: { gid: string }) => void } = {}
      vi.mocked(rpc.onBtDownloadComplete).mockImplementation((h) => {
        captor.fn = h
        return () => {}
      })
      const adapter = new Aria2Adapter(rpc)
      const handler = vi.fn()
      adapter.onBtDownloadComplete(handler)

      expect(captor.fn).toBeDefined()
      captor.fn?.({ gid: 'gid-1' })
      expect(handler).toHaveBeenCalledWith('gid-1')
    })

    it('unsubscribes via returned function', () => {
      const rpc = createMockRpc()
      const captor: { fn?: (event: { gid: string }) => void } = {}
      vi.mocked(rpc.onBtDownloadComplete).mockImplementation((h) => {
        captor.fn = h
        return () => {}
      })
      const adapter = new Aria2Adapter(rpc)
      const handler = vi.fn()
      const unsub = adapter.onBtDownloadComplete(handler)

      unsub()
      captor.fn?.({ gid: 'gid-1' })
      expect(handler).not.toHaveBeenCalled()
    })

    it('handler errors do not block other subscribers', () => {
      const rpc = createMockRpc()
      const captor: { fn?: (event: { gid: string }) => void } = {}
      vi.mocked(rpc.onBtDownloadComplete).mockImplementation((h) => {
        captor.fn = h
        return () => {}
      })
      const adapter = new Aria2Adapter(rpc)
      const throwing = vi.fn(() => {
        throw new Error('oops')
      })
      const good = vi.fn()
      adapter.onBtDownloadComplete(throwing)
      adapter.onBtDownloadComplete(good)

      captor.fn?.({ gid: 'gid-1' })
      expect(throwing).toHaveBeenCalledWith('gid-1')
      expect(good).toHaveBeenCalledWith('gid-1')
    })

    it('does not fire on onDownloadComplete events', () => {
      const rpc = createMockRpc()
      const btCaptor: { fn?: (event: { gid: string }) => void } = {}
      const dlCaptor: { fn?: (event: { gid: string }) => void } = {}
      vi.mocked(rpc.onBtDownloadComplete).mockImplementation((h) => {
        btCaptor.fn = h
        return () => {}
      })
      vi.mocked(rpc.onDownloadComplete).mockImplementation((h) => {
        dlCaptor.fn = h
        return () => {}
      })
      const adapter = new Aria2Adapter(rpc)
      const handler = vi.fn()
      adapter.onBtDownloadComplete(handler)

      expect(btCaptor.fn).toBeDefined()
      expect(dlCaptor.fn).toBeDefined()
      dlCaptor.fn?.({ gid: 'gid-1' })
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('onDownloadComplete', () => {
    it('forwards gid from aria2.onDownloadComplete notifications', () => {
      const rpc = createMockRpc()
      const captor: { fn?: (event: { gid: string }) => void } = {}
      vi.mocked(rpc.onDownloadComplete).mockImplementation((h) => {
        captor.fn = h
        return () => {}
      })
      const adapter = new Aria2Adapter(rpc)
      const handler = vi.fn()
      adapter.onDownloadComplete(handler)

      captor.fn?.({ gid: 'gid-42' })
      expect(handler).toHaveBeenCalledWith('gid-42')
    })

    it('unsubscribes via returned function', () => {
      const rpc = createMockRpc()
      const captor: { fn?: (event: { gid: string }) => void } = {}
      vi.mocked(rpc.onDownloadComplete).mockImplementation((h) => {
        captor.fn = h
        return () => {}
      })
      const adapter = new Aria2Adapter(rpc)
      const handler = vi.fn()
      const unsub = adapter.onDownloadComplete(handler)

      unsub()
      captor.fn?.({ gid: 'gid-42' })
      expect(handler).not.toHaveBeenCalled()
    })

    it('does not fire on onBtDownloadComplete events', () => {
      const rpc = createMockRpc()
      const btCaptor: { fn?: (event: { gid: string }) => void } = {}
      const dlCaptor: { fn?: (event: { gid: string }) => void } = {}
      vi.mocked(rpc.onBtDownloadComplete).mockImplementation((h) => {
        btCaptor.fn = h
        return () => {}
      })
      vi.mocked(rpc.onDownloadComplete).mockImplementation((h) => {
        dlCaptor.fn = h
        return () => {}
      })
      const adapter = new Aria2Adapter(rpc)
      const handler = vi.fn()
      adapter.onDownloadComplete(handler)

      expect(btCaptor.fn).toBeDefined()
      expect(dlCaptor.fn).toBeDefined()
      btCaptor.fn?.({ gid: 'gid-1' })
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('onDownloadError', () => {
    it('forwards gid from aria2.onDownloadError notifications', () => {
      const rpc = createMockRpc()
      const captor: { fn?: (event: { gid: string }) => void } = {}
      vi.mocked(rpc.onDownloadError).mockImplementation((h) => {
        captor.fn = h
        return () => {}
      })
      const adapter = new Aria2Adapter(rpc)
      const handler = vi.fn()
      adapter.onDownloadError(handler)

      captor.fn?.({ gid: 'gid-err' })
      expect(handler).toHaveBeenCalledWith('gid-err')
    })

    it('unsubscribes via returned function', () => {
      const rpc = createMockRpc()
      const captor: { fn?: (event: { gid: string }) => void } = {}
      vi.mocked(rpc.onDownloadError).mockImplementation((h) => {
        captor.fn = h
        return () => {}
      })
      const adapter = new Aria2Adapter(rpc)
      const handler = vi.fn()
      const unsub = adapter.onDownloadError(handler)

      unsub()
      captor.fn?.({ gid: 'gid-err' })
      expect(handler).not.toHaveBeenCalled()
    })

    it('handler errors do not block other subscribers', () => {
      const rpc = createMockRpc()
      const captor: { fn?: (event: { gid: string }) => void } = {}
      vi.mocked(rpc.onDownloadError).mockImplementation((h) => {
        captor.fn = h
        return () => {}
      })
      const adapter = new Aria2Adapter(rpc)
      const throwing = vi.fn(() => {
        throw new Error('oops')
      })
      const good = vi.fn()
      adapter.onDownloadError(throwing)
      adapter.onDownloadError(good)

      captor.fn?.({ gid: 'gid-err' })
      expect(throwing).toHaveBeenCalledWith('gid-err')
      expect(good).toHaveBeenCalledWith('gid-err')
    })
  })

  describe('getTaskBtTracker', () => {
    it('parses comma-separated bt-tracker option', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getOption).mockResolvedValue({
        'bt-tracker': 'http://a.example/announce,udp://b.example:80',
      })
      const adapter = new Aria2Adapter(rpc)
      const result = await adapter.getTaskBtTracker('gid-1')
      expect(result).toEqual([
        'http://a.example/announce',
        'udp://b.example:80',
      ])
    })

    it('returns [] when bt-tracker option is missing', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getOption).mockResolvedValue({})
      const adapter = new Aria2Adapter(rpc)
      expect(await adapter.getTaskBtTracker('gid-1')).toEqual([])
    })

    it('filters empty entries from comma-split', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getOption).mockResolvedValue({
        'bt-tracker': 'http://a,,http://b,',
      })
      const adapter = new Aria2Adapter(rpc)
      expect(await adapter.getTaskBtTracker('gid-1')).toEqual([
        'http://a',
        'http://b',
      ])
    })

    it('returns [] when bt-tracker is empty string (private-torrent path)', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getOption).mockResolvedValue({ 'bt-tracker': '' })
      const adapter = new Aria2Adapter(rpc)
      expect(await adapter.getTaskBtTracker('gid-1')).toEqual([])
    })

    it('returns [] silently when aria2 reports GID not found (post-eviction)', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getOption).mockRejectedValue(
        new Error('GID 974d06558d375212 is not found')
      )
      const adapter = new Aria2Adapter(rpc)
      expect(await adapter.getTaskBtTracker('974d06558d375212')).toEqual([])
    })

    it('rethrows non-not-found errors so RPC failures stay visible', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getOption).mockRejectedValue(
        new Error('connection refused')
      )
      const adapter = new Aria2Adapter(rpc)
      await expect(adapter.getTaskBtTracker('gid-1')).rejects.toThrow(
        /connection refused/
      )
    })
  })

  describe('addTorrent isPrivate handling', () => {
    it('overrides bt-tracker to empty when params.isPrivate=true', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addTorrent).mockResolvedValue('gid-x')
      const adapter = new Aria2Adapter(rpc)
      await adapter.addTorrent({
        metadata: new Uint8Array([1, 2, 3]),
        saveDir: '/tmp',
        isPrivate: true,
      })
      const opts = (rpc.addTorrent as Mock).mock.calls[0][2] as Record<
        string,
        string
      >
      expect(opts['bt-tracker']).toBe('')
    })

    it('omits bt-tracker override when isPrivate=false', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.addTorrent).mockResolvedValue('gid-x')
      const adapter = new Aria2Adapter(rpc)
      await adapter.addTorrent({
        metadata: new Uint8Array([1, 2, 3]),
        saveDir: '/tmp',
        isPrivate: false,
      })
      const opts = (rpc.addTorrent as Mock).mock.calls[0][2] as Record<
        string,
        string
      >
      expect(opts['bt-tracker']).toBeUndefined()
    })
  })

  describe('SQLite3-Persistence operations', () => {
    it('getHistoryCount parses string count to number', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getDownloadResultCount).mockResolvedValue({ count: '1234' })
      const adapter = new Aria2Adapter(rpc)
      const result = await adapter.getHistoryCount({ status: 'complete' })
      expect(rpc.getDownloadResultCount).toHaveBeenCalledWith({
        status: 'complete',
      })
      expect(result).toBe(1234)
    })

    it('getHistoryCount throws EngineProtocolError on unparseable count', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getDownloadResultCount).mockResolvedValue({
        count: 'not-a-number',
      })
      const adapter = new Aria2Adapter(rpc)
      await expect(adapter.getHistoryCount()).rejects.toMatchObject({
        code: ErrorCode.EngineProtocolError,
      })
    })

    it('getHistoryCount propagates fork "not enabled" error', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.getDownloadResultCount).mockRejectedValue(
        new Error('SQLite3 persistence is not enabled')
      )
      const adapter = new Aria2Adapter(rpc)
      await expect(adapter.getHistoryCount()).rejects.toThrow(
        'SQLite3 persistence is not enabled'
      )
    })

    it('searchHistory translates raw rows via translateRawToTask', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.searchDownloadResult).mockResolvedValue([
        {
          gid: 'A',
          status: 'complete',
          totalLength: '0',
          completedLength: '0',
          uploadLength: '0',
          downloadSpeed: '0',
          uploadSpeed: '0',
          connections: '0',
          numSeeders: '0',
          seeder: 'false',
          pieceLength: '0',
          numPieces: '0',
          dir: '/tmp',
          files: [],
        },
        {
          gid: 'B',
          status: 'error',
          totalLength: '0',
          completedLength: '0',
          uploadLength: '0',
          downloadSpeed: '0',
          uploadSpeed: '0',
          connections: '0',
          numSeeders: '0',
          seeder: 'false',
          pieceLength: '0',
          numPieces: '0',
          dir: '/tmp',
          files: [],
        },
      ] as Aria2RawStatus[])
      const adapter = new Aria2Adapter(rpc)
      const result = await adapter.searchHistory({ pathLike: '%video%' }, 0, 50)
      expect(rpc.searchDownloadResult).toHaveBeenCalledWith(
        { pathLike: '%video%' },
        0,
        50
      )
      expect(result).toHaveLength(2)
      expect(result[0].engineTaskId).toBe('A')
    })

    it('exportSession forwards the path', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.exportSession).mockResolvedValue('OK')
      const adapter = new Aria2Adapter(rpc)
      await adapter.exportSession('/tmp/dump.session')
      expect(rpc.exportSession).toHaveBeenCalledWith('/tmp/dump.session')
    })

    it('requeueFromHistory maps wire response to RequeueResult', async () => {
      const rpc = createMockRpc()
      vi.mocked(rpc.requeueDownloadResult).mockResolvedValue({
        gid: 'NEW999',
        strategy: 'bt-save-metadata-file',
      })
      const adapter = new Aria2Adapter(rpc)
      const result = await adapter.requeueFromHistory('OLD111', { dir: '/d' })
      expect(rpc.requeueDownloadResult).toHaveBeenCalledWith('OLD111', {
        dir: '/d',
      })
      expect(result).toEqual({
        newEngineTaskId: 'NEW999',
        strategy: 'bt-save-metadata-file',
      })
    })
  })
})

describe('getEngineTaskOptions', () => {
  it('returns options as-is from rpc.getOption', async () => {
    const rpc = createMockRpc()
    vi.mocked(rpc.getOption).mockResolvedValue({
      dir: '/tmp',
      header: ['User-Agent: Foo'] as unknown as string,
      split: '5',
    })
    const adapter = new Aria2Adapter(rpc)
    const result = await adapter.getEngineTaskOptions('gid-1')
    expect(rpc.getOption).toHaveBeenCalledWith('gid-1')
    expect(result).toEqual({
      dir: '/tmp',
      header: ['User-Agent: Foo'],
      split: '5',
    })
  })

  it('returns null when rpc throws "is not found"', async () => {
    const rpc = createMockRpc()
    vi.mocked(rpc.getOption).mockRejectedValue(
      new Error('GID gid-1 is not found')
    )
    const adapter = new Aria2Adapter(rpc)
    const result = await adapter.getEngineTaskOptions('gid-1')
    expect(result).toBeNull()
  })

  it('rethrows non-not-found errors', async () => {
    const rpc = createMockRpc()
    vi.mocked(rpc.getOption).mockRejectedValue(new Error('connection refused'))
    const adapter = new Aria2Adapter(rpc)
    await expect(adapter.getEngineTaskOptions('gid-1')).rejects.toThrow(
      'connection refused'
    )
  })
})
