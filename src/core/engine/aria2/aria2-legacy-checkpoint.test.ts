import { createHash } from 'node:crypto'
import { ErrorCode } from '@shared/errors'
import {
  type LegacyCheckpointImport,
  MAX_LEGACY_CHECKPOINT_BYTES,
} from '@shared/schemas/legacy-checkpoint'
import { describe, expect, it, vi } from 'vitest'
import { Aria2Adapter } from './aria2-adapter'
import {
  Aria2LegacyCheckpoint,
  FEATURE_LEGACY_CHECKPOINT_IMPORT_V1,
} from './aria2-legacy-checkpoint'
import { Aria2RpcClient } from './aria2-rpc-client'
import type { JsonRpcProtocol } from './json-rpc-protocol'
import type { WebSocketTransport } from './web-socket-transport'

const bytes = new Uint8Array([0, 1, 0, 0])
const sourceDigest = createHash('sha256').update(bytes).digest('hex')
const token = 'legacy-checkpoint-test-token'
const gid = '1234567890abcdef'
const targetPath = '/downloads/archive.zip'
const inspection = {
  version: '1',
  format: 'aria2-v1',
  kind: 'http',
  totalLength: '100',
  pieceLength: '16',
  infoHash: '',
  uploadLength: '0',
  completedLength: '30',
  controlDigest: sourceDigest,
  ranges: [
    { offset: '0', length: '16' },
    { offset: '32', length: '14' },
  ],
}
const saved = {
  version: '1',
  status: 'created',
  token,
  gid,
  targetPath,
  controlDigest: sourceDigest,
}
function request(): LegacyCheckpointImport {
  return {
    token,
    engineTaskId: gid,
    targetPath,
    controlFile: bytes.slice(),
    sourceDigest,
    expected: { type: 'http', totalBytes: 100, pieceBytes: 16, infoHash: null },
    files: [
      {
        path: targetPath,
        offset: 0,
        length: 100,
        identity: {
          device: '1',
          inode: '2',
          size: '100',
          mtimeNs: '1000000000000000000',
          ctimeNs: '1000000000000000001',
        },
      },
    ],
  }
}
function setup() {
  const rpc = {
    getVersion: vi.fn().mockResolvedValue({
      version: '1.37.0-motrix.17',
      enabledFeatures: [
        'SQLite3-Persistence',
        FEATURE_LEGACY_CHECKPOINT_IMPORT_V1,
      ],
    }),
    inspectLegacyCheckpointV1: vi.fn().mockResolvedValue(inspection),
    importLegacyCheckpointV1: vi.fn().mockResolvedValue(saved),
    reconcileLegacyCheckpointV1: vi.fn().mockResolvedValue(saved),
  }
  return {
    rpc,
    adapter: new Aria2LegacyCheckpoint(rpc as unknown as Aria2RpcClient),
  }
}

describe('legacy checkpoint engine boundary', () => {
  it('uses the live capability and never calls a legacy method on an older engine', async () => {
    const { rpc, adapter } = setup()
    rpc.getVersion.mockResolvedValue({
      enabledFeatures: ['SQLite3-Persistence'],
    })
    expect(await adapter.supported()).toBe(false)
    for (const operation of [
      () => adapter.inspect(bytes),
      () => adapter.import(request()),
      () => adapter.reconcile({ token, targetPath }),
    ])
      await expect(operation()).rejects.toMatchObject({
        code: ErrorCode.EngineFeatureUnavailable,
      })
    expect(rpc.inspectLegacyCheckpointV1).not.toHaveBeenCalled()
    expect(rpc.importLegacyCheckpointV1).not.toHaveBeenCalled()
    expect(rpc.reconcileLegacyCheckpointV1).not.toHaveBeenCalled()
    rpc.getVersion.mockResolvedValue({
      enabledFeatures: [FEATURE_LEGACY_CHECKPOINT_IMPORT_V1],
    })
    expect(await adapter.supported()).toBe(false)
  })

  it('does not cache a previously available runtime capability', async () => {
    const { rpc, adapter } = setup()
    expect(await adapter.supported()).toBe(true)
    rpc.getVersion.mockResolvedValue({ enabledFeatures: [] })
    await expect(adapter.import(request())).rejects.toMatchObject({
      code: ErrorCode.EngineFeatureUnavailable,
    })
    expect(rpc.importLegacyCheckpointV1).not.toHaveBeenCalled()
  })

  it('projects verified native ranges, not file length, as recorded progress', async () => {
    const { adapter } = setup()
    expect(await adapter.inspect(bytes)).toEqual({
      type: 'http',
      totalBytes: 100,
      pieceBytes: 16,
      infoHash: null,
      uploadedBytes: 0,
      sourceDigest,
      completedBytes: 30,
      ranges: [
        { offset: 0, length: 16 },
        { offset: 32, length: 14 },
      ],
    })
  })

  it.each([
    { controlDigest: 'f'.repeat(64) },
    { totalLength: '9007199254740993' },
    { completedLength: '31' },
    { pieceLength: '0' },
    { totalLength: '-1' },
    { infoHash: 'a'.repeat(40) },
    { kind: 'bittorrent' },
    {
      ranges: [
        { offset: '0', length: '20' },
        { offset: '19', length: '10' },
      ],
    },
    { ranges: [{ offset: '80', length: '30' }] },
    { version: '2' },
  ])(
    'rejects malformed or inconsistent native output: %j',
    async (override) => {
      const { rpc, adapter } = setup()
      rpc.inspectLegacyCheckpointV1.mockResolvedValue({
        ...inspection,
        ...override,
      })
      await expect(adapter.inspect(bytes)).rejects.toMatchObject({
        code: ErrorCode.EngineProtocolError,
      })
    }
  )

  it('copies the control snapshot before asynchronous capability probing', async () => {
    const { rpc, adapter } = setup()
    const mutable = bytes.slice()
    const result = adapter.inspect(mutable)
    mutable.fill(255)
    await result
    expect(rpc.inspectLegacyCheckpointV1).toHaveBeenCalledWith({
      controlFile: Buffer.from(bytes).toString('base64'),
    })
  })

  it('rejects oversized snapshots before capability probing or dispatch', async () => {
    const { rpc, adapter } = setup()
    await expect(
      adapter.inspect(new Uint8Array(MAX_LEGACY_CHECKPOINT_BYTES + 1))
    ).rejects.toMatchObject({ code: ErrorCode.InvalidSelection })
    expect(rpc.getVersion).not.toHaveBeenCalled()
  })

  it('retains file identities as exact decimal strings and checks the receipt', async () => {
    const { rpc, adapter } = setup()
    expect(await adapter.import(request())).toEqual({
      status: 'created',
      token,
      engineTaskId: gid,
      targetPath,
      sourceDigest,
    })
    expect(rpc.importLegacyCheckpointV1).toHaveBeenCalledWith(
      expect.objectContaining({
        gid,
        token,
        controlDigest: sourceDigest,
        expected: {
          kind: 'http',
          totalLength: '100',
          pieceLength: '16',
          infoHash: '',
        },
        files: [{ ...request().files[0], offset: '0', length: '100' }],
      })
    )
  })

  it.each([
    { token: 'a-different-import-token' },
    { gid: 'fedcba0987654321' },
    { targetPath: '/downloads/other.zip' },
    { controlDigest: 'f'.repeat(64) },
  ])('rejects a receipt from another transaction: %j', async (override) => {
    const { rpc, adapter } = setup()
    rpc.importLegacyCheckpointV1.mockResolvedValue({ ...saved, ...override })
    await expect(adapter.import(request())).rejects.toMatchObject({
      code: ErrorCode.EngineProtocolError,
    })
  })

  it('does not retry or create a replacement identity after an unknown RPC outcome', async () => {
    const { rpc, adapter } = setup()
    rpc.importLegacyCheckpointV1.mockRejectedValue(new Error('response lost'))
    await expect(adapter.import(request())).rejects.toThrow('response lost')
    expect(rpc.importLegacyCheckpointV1).toHaveBeenCalledTimes(1)
    expect(rpc.reconcileLegacyCheckpointV1).not.toHaveBeenCalled()
    rpc.reconcileLegacyCheckpointV1.mockResolvedValue(saved)
    expect(await adapter.reconcile({ token, targetPath })).toMatchObject({
      status: 'created',
      token,
      engineTaskId: gid,
    })
  })

  it('distinguishes absent receipts from consumed checkpoints', async () => {
    const { rpc, adapter } = setup()
    rpc.reconcileLegacyCheckpointV1.mockResolvedValue({
      version: '1',
      status: 'absent',
      token,
      targetPath,
    })
    expect(await adapter.reconcile({ token, targetPath })).toEqual({
      status: 'absent',
      token,
      targetPath,
    })
    rpc.reconcileLegacyCheckpointV1.mockResolvedValue({
      ...saved,
      status: 'consumed',
    })
    expect(await adapter.reconcile({ token, targetPath })).toMatchObject({
      status: 'consumed',
      engineTaskId: gid,
    })
    expect(rpc.importLegacyCheckpointV1).not.toHaveBeenCalled()
  })

  it('rejects stale digest, overlapping mapping and noncanonical target paths before import', async () => {
    const { rpc, adapter } = setup()
    const digestChanged = request()
    digestChanged.controlFile[0] = 255
    const badMapping = request()
    badMapping.files[0].offset = 1
    const badPath = request()
    badPath.targetPath = '/downloads/../archive.zip'
    badPath.files[0].path = badPath.targetPath
    for (const input of [digestChanged, badMapping, badPath])
      await expect(adapter.import(input)).rejects.toMatchObject({
        code: ErrorCode.InvalidSelection,
      })
    expect(rpc.importLegacyCheckpointV1).not.toHaveBeenCalled()
  })

  it('routes all methods through the real authenticated client and public engine adapter', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'aria2.getVersion')
        return {
          enabledFeatures: [
            'SQLite3-Persistence',
            FEATURE_LEGACY_CHECKPOINT_IMPORT_V1,
          ],
        }
      if (method === 'aria2.inspectLegacyCheckpointV1') return inspection
      return saved
    })
    const rpc = new Aria2RpcClient(
      {} as WebSocketTransport,
      { call, onNotification: vi.fn() } as unknown as JsonRpcProtocol,
      'fixture-secret'
    )
    const adapter = new Aria2Adapter(rpc)
    expect(await adapter.supportsLegacyCheckpointImport()).toBe(true)
    await adapter.inspectLegacyCheckpoint(bytes)
    await adapter.importLegacyCheckpoint(request())
    await adapter.reconcileLegacyCheckpoint({ token, targetPath })
    for (const [method, params] of call.mock.calls as unknown as Array<
      [string, unknown[]]
    >) {
      expect(params[0]).toBe('token:fixture-secret')
      expect([
        'aria2.getVersion',
        'aria2.inspectLegacyCheckpointV1',
        'aria2.importLegacyCheckpointV1',
        'aria2.reconcileLegacyCheckpointV1',
      ]).toContain(method)
    }
  })
})
