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
