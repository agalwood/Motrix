// @vitest-environment node
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStatus, TaskType } from '@shared/types/task'
import {
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { makeDownloadTask } from '@test-utils/task'
import { expect, it } from 'vitest'
import {
  reservedBtFinalNames,
  withBtOutputAdmission,
} from './bt-duplicate-policy'
import {
  createBtDirectStoragePlan,
  parseBtFileLayout,
} from './bt-storage-layout'
import { FileCleanupServiceImpl } from './file-cleanup-service'
import { FinalNamePickerImpl } from './final-name-picker'

async function exists(p: string) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

it('deleting a new single-file BT preserves another payload named foo.aria2', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bt-sibling-review-'))
  try {
    const other = path.join(root, 'foo.aria2')
    await writeFile(other, 'another completed download')
    const picker = new FinalNamePickerImpl({ exists })
    const chosen = await picker.pick(root, 'foo', ['foo.aria2'], true)
    expect(chosen).toBe('foo (1)')
    const cleanup = new FileCleanupServiceImpl({
      removePathRecursive: (p) => rm(p, { recursive: true, force: true }),
    })
    await cleanup.cleanup(path.join(root, chosen), TaskType.Bt, true)
    await expect(readFile(other, 'utf8')).resolves.toBe(
      'another completed download'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('reserves case-insensitive pending BT output names', async (ctx) => {
  const root = await mkdtemp(path.join(tmpdir(), 'bt-case-review-'))
  try {
    const probe = path.join(root, 'CASE-PROBE')
    await writeFile(probe, 'x')
    if (!(await exists(path.join(root, 'case-probe')))) ctx.skip()
    await rm(probe)
    const picker = new FinalNamePickerImpl({ exists })
    const firstName = await withBtOutputAdmission(root, () =>
      picker.pick(root, 'Bundle')
    )
    const first = makeDownloadTask({
      id: 'first',
      type: TaskType.Bt,
      status: TaskStatus.Queued,
      infoHash: 'a'.repeat(40),
      saveDir: root,
      finalName: firstName,
      finalPath: path.join(root, firstName),
      diskPath: path.join(root, firstName),
    })
    const plan = createBtDirectStoragePlan(
      first.finalPath,
      {
        infoHash: 'a'.repeat(40),
        torrentRootName: 'Bundle',
        multiFile: true,
        isPrivate: false,
        files: [{ fileIndex: 0, pathInsideRoot: 'data.bin' }],
      },
      path.join(root, 'meta', 'first.torrent')
    )
    await mkdir(plan.saveDir, { recursive: true })
    expect(await exists(first.finalPath)).toBe(false)
    const secondName = await withBtOutputAdmission(root, () =>
      picker.pick(root, 'bundle', reservedBtFinalNames([first], root))
    )
    expect(secondName.toLowerCase()).not.toBe(firstName.toLowerCase())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'real queued torrents must not share a case-aliased output',
  async (ctx) => {
    const root = await mkdtemp(path.join(tmpdir(), 'bt-queued-review-'))
    let handle: Awaited<ReturnType<typeof spawnAria2ForTest>> | undefined
    let disconnect: (() => void) | undefined
    const entered = Promise.withResolvers<void>()
    const server = createServer((_req, _res) => entered.resolve())
    try {
      await writeFile(path.join(root, 'CASE'), 'x')
      if (!(await exists(path.join(root, 'case')))) ctx.skip()
      await rm(path.join(root, 'CASE'))
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      )
      const port = (server.address() as { port: number }).port
      handle = await spawnAria2ForTest({
        baseDir: root,
        extraArgs: [
          '--max-concurrent-downloads=1',
          '--enable-dht6=false',
          '--bt-enable-lpd=false',
        ],
      })
      const wired = await connectAdapter(handle)
      disconnect = wired.disconnect
      await wired.adapter.createDownload({
        uris: [`http://127.0.0.1:${port}/hold`],
        saveDir: root,
        filename: 'blocker',
      })
      await entered.promise
      const picker = new FinalNamePickerImpl({ exists })
      const metadata = (name: string) =>
        Buffer.concat([
          Buffer.from(
            `d4:infod5:filesld6:lengthi1e4:pathl8:data.bineee4:name${name.length}:${name}12:piece lengthi16384e6:pieces20:`
          ),
          Buffer.alloc(20),
          Buffer.from('ee'),
        ])
      const firstMetadata = metadata('Bundle')
      const parsed = await parseBtFileLayout(firstMetadata)
      const firstName = await picker.pick(root, 'Bundle')
      const firstPath = path.join(root, firstName)
      const firstPlan = createBtDirectStoragePlan(
        firstPath,
        parsed,
        path.join(root, 'meta', 'first.torrent')
      )
      const firstGid = await wired.adapter.addTorrent({
        metadata: firstMetadata,
        ...firstPlan,
      })
      await expect
        .poll(async () => (await wired.adapter.getTaskStatus(firstGid))?.status)
        .toBe(TaskStatus.Queued)
      expect(await exists(firstPath)).toBe(false)
      const first = makeDownloadTask({
        id: 'first',
        type: TaskType.Bt,
        status: TaskStatus.Queued,
        infoHash: parsed.infoHash,
        saveDir: root,
        finalPath: firstPath,
        finalName: firstName,
        diskPath: firstPath,
      })
      const secondName = await picker.pick(
        root,
        'bundle',
        reservedBtFinalNames([first], root)
      )
      const secondMetadata = metadata('bundle')
      const secondPlan = createBtDirectStoragePlan(
        path.join(root, secondName),
        await parseBtFileLayout(secondMetadata),
        path.join(root, 'meta', 'second.torrent')
      )
      const secondGid = await wired.adapter.addTorrent({
        metadata: secondMetadata,
        ...secondPlan,
      })
      const firstFiles = await wired.adapter.getTaskFiles(firstGid)
      const secondFiles = await wired.adapter.getTaskFiles(secondGid)
      expect(secondFiles[0].path.toLowerCase()).not.toBe(
        firstFiles[0].path.toLowerCase()
      )
    } finally {
      disconnect?.()
      await handle?.kill()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
  15000
)
