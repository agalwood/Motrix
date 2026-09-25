// @vitest-environment node

import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStatus } from '@shared/types/task'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBtDirectStoragePlan,
  parseBtFileLayout,
} from './bt-storage-layout'
import { TorrentMetaStoreImpl } from './torrent-meta-store'

type BencodeValue =
  | string
  | number
  | Buffer
  | BencodeValue[]
  | { [key: string]: BencodeValue }

function encode(value: BencodeValue): Buffer {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (Array.isArray(value))
    return Buffer.concat([
      Buffer.from('l'),
      ...value.map(encode),
      Buffer.from('e'),
    ])
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const bytes = Buffer.from(value)
    return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes])
  }
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(value)
      .sort()
      .flatMap((key) => [encode(key), encode(value[key])]),
    Buffer.from('e'),
  ])
}

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'direct BT output (real aria2)',
  () => {
    let root: string | undefined
    let handle: Aria2Handle | undefined
    let disconnect: (() => void) | undefined

    afterEach(async () => {
      disconnect?.()
      await handle?.kill()
      if (root) await rm(root, { recursive: true, force: true })
    })

    it.each([false, true])(
      'checks and seeds final files with multiFile=%s',
      async (multiFile) => {
        root = await mkdtemp(path.join(tmpdir(), 'motrix-bt-direct-'))
        const first = Buffer.from('first payload')
        const second = Buffer.from('second payload')
        const data = multiFile ? Buffer.concat([first, second]) : first
        const info: { [key: string]: BencodeValue } = {
          name: 'original',
          'piece length': 16384,
          pieces: createHash('sha1').update(data).digest(),
          ...(multiFile
            ? {
                files: [
                  { length: first.length, path: ['nested', 'first.bin'] },
                  { length: second.length, path: ['second.bin'] },
                ],
              }
            : { length: first.length }),
        }
        const metadata = encode({ info })
        const finalPath = path.join(
          root,
          multiFile ? 'Chosen folder' : 'chosen.bin'
        )
        const plan = createBtDirectStoragePlan(
          finalPath,
          await parseBtFileLayout(metadata),
          path.join(root, 'metadata', 'task.torrent')
        )
        if (multiFile) {
          await mkdir(path.join(finalPath, 'nested'), { recursive: true })
          await writeFile(path.join(finalPath, 'nested', 'first.bin'), first)
          await writeFile(path.join(finalPath, 'second.bin'), second)
        } else await writeFile(finalPath, first)
        handle = await spawnAria2ForTest({
          baseDir: root,
          extraArgs: [
            '--seed-time=60',
            '--seed-ratio=0',
            '--enable-dht6=false',
            '--bt-enable-lpd=false',
          ],
        })
        const wired = await connectAdapter(handle)
        disconnect = wired.disconnect
        const params = {
          metadata,
          saveDir: plan.saveDir,
          outputFilePaths: plan.outputFilePaths,
          outputRoot: plan.outputRoot,
          checkIntegrity: true,
          seedTime: 60,
          seedRatio: 0,
        }
        const gid = await wired.adapter.addTorrent(params)
        await expect
          .poll(async () => (await wired.adapter.getTaskStatus(gid))?.status, {
            timeout: 10000,
          })
          .toBe(TaskStatus.Seeding)
        const files = await wired.adapter.getTaskFiles(gid)
        const metadataName = `${createHash('sha1').update(metadata).digest('hex')}.torrent`
        expect(await readFile(path.join(plan.saveDir, metadataName))).toEqual(
          metadata
        )
        expect(
          (await readdir(root)).filter((name) => name.endsWith('.torrent'))
        ).toEqual([])
        expect(files.map((file) => file.path)).toEqual(
          multiFile
            ? [
                path.join(finalPath, 'nested', 'first.bin'),
                path.join(finalPath, 'second.bin'),
              ]
            : [finalPath]
        )
        expect(
          (await readdir(root)).some(
            (name) => name === '.motrix' || name.endsWith('.motrix')
          )
        ).toBe(false)
        expect(await readFile(files[0].path)).toEqual(first)
        // Rechecking the same paths after removing the engine identity must
        // discover the completed bytes instead of allocating another output.
        await wired.adapter.forceRemoveTask(gid)
        await wired.adapter.removeDownloadResult(gid)
        const retryGid = await wired.adapter.addTorrent(params)
        await expect
          .poll(
            async () => (await wired.adapter.getTaskStatus(retryGid))?.status,
            { timeout: 10000 }
          )
          .toBe(TaskStatus.Seeding)
        expect(
          (await wired.adapter.getTaskFiles(retryGid)).map((file) => file.path)
        ).toEqual(files.map((file) => file.path))
      },
      25000
    )
  }
)

it.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp()).each([false, true])(
  'downloads and restores a single file without exposing torrent metadata (sqlite=%s)',
  async (sqlite) => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-bt-metadata-'))
    let handle: Aria2Handle | undefined
    let disconnect: (() => void) | undefined
    const payload = Buffer.alloc(128 * 1024, 42)
    let requests = 0
    const server = createServer((request, response) => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
      if (request.url !== '/original.bin' || !range) {
        response.writeHead(400).end()
        return
      }
      requests++
      const start = Number(range[1])
      const end = Math.min(
        Number(range[2] || payload.length - 1),
        payload.length - 1
      )
      response.writeHead(206, {
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${payload.length}`,
      })
      response.end(payload.subarray(start, end + 1))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server address')
      const metadata = encode({
        info: {
          name: 'original.bin',
          length: payload.length,
          'piece length': 16384,
          pieces: Buffer.concat(
            Array.from({ length: payload.length / 16384 }, () =>
              createHash('sha1').update(payload.subarray(0, 16384)).digest()
            )
          ),
        },
        'url-list': [`http://127.0.0.1:${address.port}/original.bin`],
      })
      const downloads = path.join(root, 'downloads')
      await mkdir(downloads)
      const finalPath = path.join(downloads, 'Chosen 文件.bin')
      const store = new TorrentMetaStoreImpl(
        path.join(root, 'app-data', 'torrents')
      )
      const metadataPath = await store.persist('task', metadata)
      const plan = createBtDirectStoragePlan(
        finalPath,
        await parseBtFileLayout(metadata),
        metadataPath
      )
      const sessionPath = path.join(root, 'aria2.session')
      const startEngine = async (restart = false) => {
        handle = await spawnAria2ForTest({
          baseDir: root,
          extraArgs: [
            '--enable-dht6=false',
            '--bt-enable-lpd=false',
            '--bt-tracker=',
            '--all-proxy=',
            '--http-proxy=',
            '--https-proxy=',
            '--no-proxy=*',
            '--force-save=true',
            '--auto-save-interval=1',
            `--enable-sqlite3-persistence=${sqlite}`,
            `--sqlite3-db-path=${path.join(root, 'aria2.db')}`,
            `--save-session=${sessionPath}`,
            ...(!sqlite && restart ? [`--input-file=${sessionPath}`] : []),
          ],
        })
        const wired = await connectAdapter(handle)
        disconnect = wired.disconnect
        return wired
      }
      let wired = await startEngine()
      const params = { metadata, ...plan, seedTime: 60, seedRatio: 0 }
      const gid = await wired.adapter.addTorrent(params)
      await expect
        .poll(async () => (await wired.adapter.getTaskStatus(gid))?.status, {
          timeout: 10000,
        })
        .toBe(TaskStatus.Seeding)
      expect(requests).toBeGreaterThan(0)
      expect(await readFile(finalPath)).toEqual(payload)
      expect(
        (await readdir(downloads)).filter((name) => name.endsWith('.torrent'))
      ).toEqual([])
      const metadataName = `${createHash('sha1').update(metadata).digest('hex')}.torrent`
      expect(await readFile(path.join(plan.saveDir, metadataName))).toEqual(
        metadata
      )
      await wired.adapter.pauseTask(gid)
      await expect
        .poll(async () => (await wired.adapter.getTaskStatus(gid))?.status)
        .toBe(TaskStatus.Paused)
      disconnect?.()
      if (sqlite && handle) {
        // SQLite must recover the paused owner without a shutdown flush.
        const proc = handle.proc
        await new Promise<void>((resolve) => {
          proc.once('exit', () => resolve())
          proc.kill('SIGKILL')
        })
      } else await handle?.kill()
      wired = await startEngine(true)
      await expect
        .poll(async () => (await wired.adapter.getTaskStatus(gid))?.status)
        .toBe(TaskStatus.Paused)
      expect(
        (await wired.adapter.getTaskFiles(gid)).map((file) => file.path)
      ).toEqual([finalPath])
      await wired.adapter.resumeTask(gid)
      await expect
        .poll(async () => (await wired.adapter.getTaskStatus(gid))?.status, {
          timeout: 10000,
        })
        .toBe(TaskStatus.Seeding)
      await wired.adapter.forceRemoveTask(gid)
      await wired.adapter.removeDownloadResult(gid)
      const reseedGid = await wired.adapter.addTorrent({
        ...params,
        metadata: await store.read(metadataPath),
        checkIntegrity: true,
      })
      await expect
        .poll(
          async () => (await wired.adapter.getTaskStatus(reseedGid))?.status,
          { timeout: 10000 }
        )
        .toBe(TaskStatus.Seeding)
      expect(await readFile(finalPath)).toEqual(payload)
      expect(
        (await readdir(downloads)).filter((name) => name.endsWith('.torrent'))
      ).toEqual([])
      expect(await store.read(metadataPath)).toEqual(new Uint8Array(metadata))
    } finally {
      disconnect?.()
      await handle?.kill()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
  30000
)

it.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'seeds payload whose name matches an aria2 control file',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-bt-control-'))
    let handle: Aria2Handle | undefined
    let disconnect: (() => void) | undefined
    try {
      const first = Buffer.from('payload that must remain intact')
      const second = Buffer.from('second payload')
      const metadata = encode({
        info: {
          name: 'bundle',
          'piece length': 16384,
          pieces: createHash('sha1')
            .update(Buffer.concat([first, second]))
            .digest(),
          files: [
            { length: first.length, path: ['bundle.aria2'] },
            { length: second.length, path: ['second.bin'] },
          ],
        },
      })
      const finalPath = path.join(root, 'Chosen folder')
      const parsed = await parseBtFileLayout(metadata)
      const plan = createBtDirectStoragePlan(
        finalPath,
        parsed,
        path.join(root, 'metadata', 'task.torrent')
      )
      const payloadRoot = finalPath
      await mkdir(payloadRoot, { recursive: true })
      await writeFile(path.join(payloadRoot, 'bundle.aria2'), first)
      await writeFile(path.join(payloadRoot, 'second.bin'), second)
      handle = await spawnAria2ForTest({
        baseDir: root,
        extraArgs: [
          '--seed-time=60',
          '--seed-ratio=0',
          '--enable-dht6=false',
          '--bt-enable-lpd=false',
        ],
      })
      const wired = await connectAdapter(handle)
      disconnect = wired.disconnect
      const gid = await wired.adapter.addTorrent({
        metadata,
        ...plan,
        checkIntegrity: true,
        seedTime: 60,
        seedRatio: 0,
      })
      await expect
        .poll(
          async () => {
            const task = await wired.adapter.getTaskStatus(gid)
            return `${task?.status}:${task?.errorMessage ?? ''}`
          },
          { timeout: 10000 }
        )
        .toBe('seeding:')
      expect(await readFile(path.join(payloadRoot, 'bundle.aria2'))).toEqual(
        first
      )
    } finally {
      disconnect?.()
      await handle?.kill()
      await rm(root, { recursive: true, force: true })
    }
  },
  25000
)
