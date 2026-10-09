// @vitest-environment node
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AddTorrentParams } from '@core/engine/engine-adapter'
import { describe, expect, it, vi } from 'vitest'
import { Aria2Adapter } from './aria2-adapter'
import type { Aria2RpcClient } from './aria2-rpc-client'

const gid = '1234567890abcdef'
const saveDir = '/confirmed/legacy/downloads'
const tracker = 'http://127.0.0.1:45123/announce'

async function fixture() {
  const addTorrent = vi.fn().mockResolvedValue(gid)
  const ordinaryAddTorrent = vi.fn()
  const getVersion = vi.fn(async () => ({
    version: '1.37.0',
    enabledFeatures: [
      'SQLite3-Persistence',
      'LegacyCheckpointImportV1',
      'LegacyTorrentMetadataV1',
    ],
  }))
  const rpc = {
    addLegacyTorrentV1: addTorrent,
    addTorrent: ordinaryAddTorrent,
    getVersion,
    onBtDownloadComplete: vi.fn(),
    onDownloadComplete: vi.fn(),
    onDownloadError: vi.fn(),
  } as unknown as Aria2RpcClient
  const adapter = new Aria2Adapter(rpc)
  const policy = vi.fn().mockResolvedValue({
    trackers: ['https://unrelated.example/announce'],
    isPrivate: false,
  })
  adapter.configureBtTrackerPolicy(policy)
  const params: AddTorrentParams = {
    metadata: await readFile(
      path.resolve(
        'tests/fixtures/legacy-v1/generated/downloads/a16dc78c94ce589ed4666ab32285f2d188edf26f.torrent'
      )
    ),
    legacyCheckpointActivation: {
      token: 'legacy_policy_test_token',
      targetPath: `${saveDir}/fixture-bundle`,
    },
    gid,
    saveDir,
    pause: true,
    selectedFiles: [1],
    isPrivate: true,
    extraEngineOptions: { 'bt-tracker': tracker },
  }
  params.durableMetadata = {
    path: '/authorized/backup/source.torrent',
    digest: createHash('sha256').update(params.metadata).digest('hex'),
  }
  return { adapter, addTorrent, ordinaryAddTorrent, getVersion, policy, params }
}

describe('legacy BT activation dispatch safety', () => {
  it('keeps explicit selection and original trackers instead of global policy', async () => {
    const f = await fixture()
    await f.adapter.addTorrent(f.params)
    expect(f.policy).not.toHaveBeenCalled()
    expect(f.ordinaryAddTorrent).not.toHaveBeenCalled()
    expect(f.addTorrent).toHaveBeenCalledOnce()
    expect(f.addTorrent.mock.calls[0]?.[0].options).toMatchObject({
      gid,
      dir: saveDir,
      pause: 'true',
      'select-file': '1',
      'bt-tracker': tracker,
      'check-integrity': 'true',
      'bt-seed-unverified': 'false',
      'bt-hash-check-seed': 'false',
      'seed-time': '0',
      'bt-remove-unselected-file': 'false',
    })
  })

  it('cannot let extra options unpause, redirect or destructively restart old files', async () => {
    const f = await fixture()
    f.params.extraEngineOptions = {
      ...f.params.extraEngineOptions,
      pause: 'false',
      dir: '/unconfirmed/destination',
      'select-file': '2',
      'index-out': ['1=/unconfirmed/overwrite.bin'],
      out: 'replacement.bin',
      'piece-length': '1M',
      'check-integrity': 'false',
      'bt-seed-unverified': 'true',
      'bt-hash-check-seed': 'true',
      'seed-time': '999',
      'bt-remove-unselected-file': 'true',
      'remove-control-file': 'true',
      'allow-overwrite': 'true',
      'auto-file-renaming': 'true',
    }
    // Rejecting unsafe options or pinning them are both safe. Dispatching
    // them is not: paused admission must precede application ownership.
    try {
      await f.adapter.addTorrent(f.params)
    } catch {
      expect(f.addTorrent).not.toHaveBeenCalled()
      return
    }
    const options = f.addTorrent.mock.calls[0]?.[0].options
    expect(options).toMatchObject({
      gid,
      dir: saveDir,
      pause: 'true',
      'select-file': '1',
      'check-integrity': 'true',
      'bt-seed-unverified': 'false',
      'bt-hash-check-seed': 'false',
      'seed-time': '0',
      'bt-remove-unselected-file': 'false',
      'remove-control-file': 'false',
      'allow-overwrite': 'false',
      'auto-file-renaming': 'false',
    })
    expect(options).not.toHaveProperty('index-out')
    expect(options).not.toHaveProperty('out')
    expect(options).not.toHaveProperty('piece-length')
  })

  it('rejects an older engine without silently falling back to ordinary addTorrent', async () => {
    const f = await fixture()
    f.getVersion.mockResolvedValue({
      version: '1.37.0',
      enabledFeatures: ['SQLite3-Persistence', 'LegacyCheckpointImportV1'],
    })
    await expect(f.adapter.addTorrent(f.params)).rejects.toThrow(
      'checkpointUnavailable'
    )
    expect(f.addTorrent).not.toHaveBeenCalled()
    expect(f.ordinaryAddTorrent).not.toHaveBeenCalled()
  })

  it.each<Partial<AddTorrentParams>>([
    { pause: false },
    { gid: undefined },
    { selectedFiles: [] },
    { durableMetadata: undefined },
    {
      durableMetadata: {
        path: '/authorized/backup/source.torrent',
        digest: '0'.repeat(64),
      },
    },
    { durableMetadata: { path: '../source.torrent', digest: '0'.repeat(64) } },
    { outputRoot: '/another/root' },
    { outputFilePaths: [{ fileIndex: 0, relativePath: 'another.bin' }] },
  ])(
    'rejects incomplete or remapped activation before dispatch: %j',
    async (override) => {
      const f = await fixture()
      await expect(
        f.adapter.addTorrent({ ...f.params, ...override })
      ).rejects.toThrow()
      expect(f.addTorrent).not.toHaveBeenCalled()
      expect(f.policy).not.toHaveBeenCalled()
    }
  )
})
