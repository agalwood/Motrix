// @vitest-environment node
// Opt in with MOTRIX_LEGACY_CHECKPOINT_ENGINE pointing to an engine that
// implements LegacyCheckpointImportV1. The ordinary bundled engine may not.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
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
import { legacyBtActivationFixture } from '@test-utils/legacy-bt-activation-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const binaryPath = process.env.MOTRIX_LEGACY_CHECKPOINT_ENGINE
const fixtures = path.resolve('tests/fixtures/legacy-v1/generated/downloads')
const totalBytes = 4194304
const completedBytes = 1638400
const payloadDigest =
  'a117210941a0b00dcb2d8577e680d84b6fa0eaf760d2afc654c953b9859d54fa'
const gid = '2222222222222222'
const token = 'real_v1_checkpoint_import_0001'

function secureWindowsFixture(filename: string, directory = false): void {
  if (process.platform !== 'win32') return
  const sid = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ],
    { encoding: 'utf8' }
  ).trim()
  if (directory)
    execFileSync('icacls.exe', [
      filename,
      '/inheritance:r',
      '/grant:r',
      `*${sid}:(OI)(CI)F`,
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
    ])
  execFileSync('icacls.exe', [
    filename,
    '/setowner',
    `*${sid}`,
    ...(directory ? ['/T'] : []),
  ])
}

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
      secureWindowsFixture(root, true)
      ranges.length = 0
      targetPath = path.join(root, 'partial.bin')
      const partial = gunzipSync(
        await readFile(path.join(fixtures, 'partial.bin.gz'))
      )
      expect(partial.byteLength).toBe(completedBytes)
      await writeFile(targetPath, partial)
      secureWindowsFixture(targetPath)
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
        // The native imported checkpoint key uses aria2's forward-slash form.
        saveDir:
          process.platform === 'win32' ? root.replaceAll('\\', '/') : root,
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

    it('activates a durable BT receipt paused and restores the same selection after termination', async () => {
      const { adapter, rpc } = wired!
      const target = path.join(root, 'fixture-bundle')
      await mkdir(target)
      const files: LegacyCheckpointImport['files'] = []
      for (const [index, name] of ['first.bin', 'second.bin'].entries()) {
        const filename = path.join(target, name)
        await writeFile(filename, Buffer.alloc(16384, index + 1))
        secureWindowsFixture(filename)
        const identity = await stat(filename, { bigint: true })
        files.push({
          path: filename,
          offset: index * 16384,
          length: 16384,
          identity: {
            device: String(identity.dev),
            inode: String(identity.ino),
            size: String(identity.size),
            mtimeNs: String(identity.mtimeNs),
            ctimeNs: String(identity.ctimeNs),
          },
        })
      }
      const controlFile = await readFile(
        path.join(fixtures, 'fixture-bundle.aria2')
      )
      const inspection = await adapter.inspectLegacyCheckpoint(controlFile)
      const request: LegacyCheckpointImport = {
        ...input,
        targetPath: target,
        controlFile,
        sourceDigest: inspection.sourceDigest,
        files,
        expected: {
          type: inspection.type,
          totalBytes: inspection.totalBytes,
          pieceBytes: inspection.pieceBytes,
          infoHash: inspection.infoHash,
        },
      }
      const receipt = await adapter.importLegacyCheckpoint(request)
      const metadata = await readFile(
        path.join(fixtures, 'a16dc78c94ce589ed4666ab32285f2d188edf26f.torrent')
      )
      const metadataPath = path.join(root, 'authorized.torrent')
      await writeFile(metadataPath, metadata)
      secureWindowsFixture(metadataPath)
      const before = await Promise.all(files.map((file) => readFile(file.path)))
      expect(await adapter.supportsLegacyBtActivation()).toBe(true)
      await adapter.addTorrent({
        metadata,
        gid,
        saveDir: root,
        pause: true,
        selectedFiles: [1],
        isPrivate: true,
        legacyCheckpointActivation: { token, targetPath: target },
        durableMetadata: {
          path: metadataPath,
          digest: createHash('sha256').update(metadata).digest('hex'),
        },
      })
      expect((await rpc.tellStatus(gid)).status).toBe('paused')
      // Terminate without saveSession: the add RPC must already be durable.
      handle!.proc.kill('SIGKILL')
      await stopEngine()
      const restored = await startEngine()
      const status = await restored.rpc.tellStatus(gid)
      expect(status.status).toBe('paused')
      expect(status.files.map((file) => file.selected)).toEqual([
        'true',
        'false',
      ])
      expect((await restored.rpc.tellWaiting(0, 10)).length).toBe(1)
      expect(
        await restored.adapter.reconcileLegacyCheckpoint({
          token,
          targetPath: target,
        })
      ).toEqual(receipt)
      expect(
        await Promise.all(files.map((file) => readFile(file.path)))
      ).toEqual(before)
    }, 45000)

    it('runs the migration service from authorized v1 records through binding before unpause', async () => {
      const { adapter, rpc } = wired!
      const fixture = await legacyBtActivationFixture(adapter)
      try {
        secureWindowsFixture(fixture.root, true)
        const original = await readFile(
          path.join(fixture.downloads, 'fixture-bundle', 'first.bin')
        )
        const resume = adapter.resumeTask.bind(adapter)
        const resumed = vi
          .spyOn(adapter, 'resumeTask')
          .mockImplementation(async (id) => {
            expect((await rpc.tellStatus(id)).status).toBe('paused')
            expect(
              fixture.db.getTask(fixture.taskId)?.instances[0].payload
                .legacyBtActivation
            ).toMatchObject({
              stage: 'bound',
              engineTaskId: id,
            })
            await resume(id)
          })
        expect(
          await fixture.service.activate(
            fixture.taskId,
            async () => fixture.downloads
          )
        ).toBe(true)
        expect(resumed).toHaveBeenCalledOnce()
        const state = fixture.db.getTask(fixture.taskId)?.instances[0].payload
          .legacyBtActivation
        expect(state).toMatchObject({ stage: 'active' })
        expect(
          await readFile(
            path.join(fixture.downloads, 'fixture-bundle', 'first.bin')
          )
        ).toEqual(original)
        resumed.mockRestore()
      } finally {
        await stopEngine()
        await fixture.dispose()
      }
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
    }, 20000)

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
