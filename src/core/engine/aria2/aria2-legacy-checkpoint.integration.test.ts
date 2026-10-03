// @vitest-environment node
// Opt in with MOTRIX_LEGACY_CHECKPOINT_ENGINE pointing to an engine that
// implements LegacyCheckpointImportV1. The ordinary bundled engine may not.
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { LegacyCheckpointImport } from '@shared/schemas/legacy-checkpoint'
import {
  type Aria2Handle,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const binaryPath = process.env.MOTRIX_LEGACY_CHECKPOINT_ENGINE
const fixtures = path.resolve('tests/fixtures/legacy-v1/generated/downloads')
const totalBytes = 4194304
const completedBytes = 1638400
const payloadDigest =
  'a117210941a0b00dcb2d8577e680d84b6fa0eaf760d2afc654c953b9859d54fa'
const gid = '2222222222222222'
const token = 'real_v1_checkpoint_import_0001'

async function until<T>(read: () => Promise<T | false>): Promise<T> {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== false) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Legacy checkpoint integration timed out')
}

describe.skipIf(!binaryPath)(
  'real v1 checkpoint through the app adapter',
  () => {
    let root: string
    let handle: Aria2Handle | undefined
    let wired: Awaited<ReturnType<typeof connectAdapter>> | undefined
    let server: Server | undefined
    let targetPath: string
    let input: LegacyCheckpointImport
    const ranges: string[] = []

    async function stopEngine(): Promise<void> {
      wired?.disconnect()
      wired = undefined
      await handle?.kill()
      handle = undefined
    }

    async function startEngine() {
      handle = await spawnAria2ForTest({
        baseDir: root,
        binaryPath,
        extraArgs: [
          '--enable-sqlite3-persistence=true',
          `--sqlite3-db-path=${path.join(root, 'engine.db')}`,
          '--force-save=true',
          '--continue=false',
          '--split=1',
          '--max-connection-per-server=1',
          '--file-allocation=none',
          '--max-tries=1',
        ],
      })
      wired = await connectAdapter(handle)
      expect(await wired.adapter.supportsLegacyCheckpointImport()).toBe(true)
      return wired
    }

    beforeEach(async () => {
      root = await realpath(
        await mkdtemp(path.join(tmpdir(), 'motrix-v1-native-'))
      )
      ranges.length = 0
      targetPath = path.join(root, 'partial.bin')
      const partial = gunzipSync(
        await readFile(path.join(fixtures, 'partial.bin.gz'))
      )
      expect(partial.byteLength).toBe(completedBytes)
      await writeFile(targetPath, partial)
      const { adapter } = await startEngine()
      const controlFile = await readFile(
        path.join(fixtures, 'partial.bin.aria2')
      )
      const inspection = await adapter.inspectLegacyCheckpoint(controlFile)
      const identity = await stat(targetPath, { bigint: true })
      input = {
        token,
        engineTaskId: gid,
        targetPath,
        controlFile,
        sourceDigest: inspection.sourceDigest,
        expected: {
          type: inspection.type,
          totalBytes: inspection.totalBytes,
          pieceBytes: inspection.pieceBytes,
          infoHash: inspection.infoHash,
        },
        files: [
          {
            path: targetPath,
            offset: 0,
            length: totalBytes,
            identity: {
              device: String(identity.dev),
              inode: String(identity.ino),
              size: String(identity.size),
              mtimeNs: String(identity.mtimeNs),
              ctimeNs: String(identity.ctimeNs),
            },
          },
        ],
      }
    }, 15000)

    afterEach(async () => {
      await stopEngine()
      if (server) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server?.close(() => resolve()))
        server = undefined
      }
      if (root) await rm(root, { recursive: true, force: true })
    })

    it('inspects actual saved HTTP blocks and BT logical length', async () => {
      const { adapter } = wired!
      await expect(
        adapter.inspectLegacyCheckpoint(input.controlFile)
      ).resolves.toMatchObject({
        type: 'http',
        totalBytes,
        pieceBytes: 1048576,
        completedBytes,
        ranges: [{ offset: 0, length: completedBytes }],
      })
      await expect(
        adapter.inspectLegacyCheckpoint(
          await readFile(path.join(fixtures, 'fixture-bundle.aria2'))
        )
      ).resolves.toMatchObject({
        type: 'bt',
        totalBytes: 32768,
        pieceBytes: 16384,
        infoHash: '45c7c651e500cc0ceaa544d6fbafcb21b8cd52f8',
        completedBytes: 0,
        ranges: [],
      })
      expect(await wired!.rpc.tellActive()).toEqual([])
    })

    it('persists a silent import across restart, resumes missing bytes and consumes its receipt', async () => {
      const payload = Buffer.alloc(totalBytes)
      for (let i = 0; i < payload.length; i++) payload[i] = i % 251
      server = createServer((req, res) => {
        ranges.push(req.headers.range ?? 'none')
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
        const start = match ? Number(match[1]) : 0
        const end = match?.[2] ? Number(match[2]) : totalBytes - 1
        res.writeHead(match ? 206 : 200, {
          'Accept-Ranges': 'bytes',
          ETag: '"motrix-v1-generated-fixture"',
          'Content-Length': end - start + 1,
          ...(match
            ? { 'Content-Range': `bytes ${start}-${end}/${totalBytes}` }
            : {}),
        })
        res.end(
          req.method === 'HEAD' ? undefined : payload.subarray(start, end + 1)
        )
      })
      await new Promise<void>((resolve) =>
        server!.listen(0, '127.0.0.1', resolve)
      )
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('No HTTP port')
      const original = await readFile(targetPath)
      const receipt = await wired!.adapter.importLegacyCheckpoint(input)
      expect(receipt.status).toBe('created')
      await expect(
        wired!.adapter.importLegacyCheckpoint(input)
      ).resolves.toEqual(receipt)
      await expect(wired!.rpc.tellActive()).resolves.toEqual([])
      await expect(wired!.rpc.tellWaiting(0, 10)).resolves.toEqual([])
      expect(ranges).toEqual([])
      expect(await readFile(targetPath)).toEqual(original)
      await wired!.rpc.saveSession()
      await stopEngine()
      const { adapter, rpc } = await startEngine()
      await expect(
        adapter.reconcileLegacyCheckpoint({ token, targetPath })
      ).resolves.toEqual(receipt)
      await expect(adapter.getCheckpointStatus(targetPath)).resolves.toBe(
        'present'
      )
      await adapter.createDownload({
        uris: [`http://127.0.0.1:${address.port}/partial.bin`],
        saveDir: root,
        filename: 'partial.bin',
        gid,
        pause: true,
        resumePolicy: 'checkpoint',
        extraEngineOptions: {
          'piece-length': String(input.expected.pieceBytes),
        },
      })
      expect((await rpc.tellStatus(gid, ['status'])).status).toBe('paused')
      expect(ranges).toEqual([])
      await rpc.unpause(gid)
      await until(async () => {
        const status = await rpc.tellStatus(gid, ['status', 'errorMessage'])
        if (status.status === 'error') throw new Error(status.errorMessage)
        return status.status === 'complete'
      })
      // aria2 first learns the remote length, then requests the saved suffix.
      // Import and paused task creation above must remain completely offline.
      expect(
        ranges.filter((range) => range === 'none').length
      ).toBeLessThanOrEqual(1)
      expect(ranges.filter((range) => range !== 'none')).toEqual([
        `bytes=${completedBytes}-${totalBytes - 1}`,
      ])
      expect(
        createHash('sha256')
          .update(await readFile(targetPath))
          .digest('hex')
      ).toBe(payloadDigest)
      const consumed = { ...receipt, status: 'consumed' }
      await expect(
        adapter.reconcileLegacyCheckpoint({ token, targetPath })
      ).resolves.toEqual(consumed)
      // Original file identities are now stale. A retry returns the durable
      // receipt and must not recreate the imported checkpoint.
      await expect(adapter.importLegacyCheckpoint(input)).resolves.toEqual(
        consumed
      )
      const source = gunzipSync(
        await readFile(path.join(fixtures, 'partial.bin.gz'))
      )
      expect(source).toEqual(original)
    }, 45000)

    it('rejects changed file identities without creating a receipt or checkpoint', async () => {
      const { adapter } = wired!
      await writeFile(targetPath, Buffer.alloc(completedBytes, 17))
      await expect(adapter.importLegacyCheckpoint(input)).rejects.toThrow()
      await expect(
        adapter.reconcileLegacyCheckpoint({ token, targetPath })
      ).resolves.toEqual({
        token,
        targetPath,
        status: 'absent',
      })
      await expect(adapter.getCheckpointStatus(targetPath)).resolves.toBe(
        'absent'
      )
      expect(await readFile(targetPath)).toEqual(
        Buffer.alloc(completedBytes, 17)
      )
    })

    it('rejects a token replay with a different reserved task ID', async () => {
      const { adapter } = wired!
      const receipt = await adapter.importLegacyCheckpoint(input)
      await expect(
        adapter.importLegacyCheckpoint({
          ...input,
          engineTaskId: '3333333333333333',
        })
      ).rejects.toThrow()
      await expect(
        adapter.reconcileLegacyCheckpoint({ token, targetPath })
      ).resolves.toEqual(receipt)
    })
  }
)
