// @vitest-environment node
import {
  cp,
  link,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MotrixDatabase } from '@core/session/motrix-database'
import { TaskManager } from '@core/task/task-manager'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LegacyImportService } from './import-service'
import {
  authorizeLegacySource,
  authorizeLegacyTorrent,
  scanLegacySource,
} from './source-scanner'

const fixtures = fileURLToPath(
  new URL('../../../tests/fixtures/legacy-v1/generated/', import.meta.url)
)
const cleanup: Array<() => Promise<void>> = []
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'motrix-metadata-grant-'))
  )
  await cp(fixtures, root, { recursive: true })
  const profile = path.join(root, 'profile')
  const downloads = path.join(root, 'downloads')
  for (const name of ['download.session', 'system.json']) {
    const file = path.join(profile, name)
    await writeFile(
      file,
      (await readFile(file, 'utf8'))
        .replaceAll('__FIXTURE_ROOT__', profile)
        .replaceAll('__FIXTURE_DOWNLOADS__', downloads)
        .replaceAll('__FIXTURE_HTTP_PORT__', '18080')
    )
  }
  const provenance = JSON.parse(
    await readFile(path.join(root, 'provenance.json'), 'utf8')
  )
  const metadata = path.join(downloads, provenance.bt.metadataFilename)
  const db = new MotrixDatabase(path.join(root, 'motrix.db'))
  db.init()
  const tasks = new TaskManager()
  let now = Date.now()
  const service = new LegacyImportService({
    db,
    taskManager: tasks,
    backupRoot: path.join(root, 'backups'),
    isProcessRunning: () => false,
    publishTasks: vi.fn(),
    now: () => now,
  })
  cleanup.push(async () => {
    await service.drain()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const source = await service.addSource(profile)
  const preview = await service.scan(source.sourceHandle)
  const item = preview.items.find((entry) => entry.type === 'bt')
  if (!item) throw new Error('Missing generated BT fixture')
  const request = { previewId: preview.previewId, itemId: item.itemId }
  return {
    root,
    profile,
    downloads,
    metadata,
    provenance,
    db,
    tasks,
    service,
    source,
    preview,
    request,
    expire: () => {
      now += 16 * 60 * 1000
    },
  }
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((operation) => operation()))
})

describe('exact legacy torrent metadata authorization', () => {
  it('imports explicitly chosen external metadata through a safe backup alias and invalidates the old preview', async () => {
    const f = await fixture()
    const original = await readFile(f.metadata)
    const next = await f.service.authorizeMetadata(
      f.request,
      async () => f.metadata
    )
    const item = next?.items.find((entry) => entry.itemId === f.request.itemId)
    expect(item).toMatchObject({
      type: 'bt',
      name: 'fixture-bundle',
      selectable: true,
    })
    await expect(
      f.service.commit({
        previewId: f.preview.previewId,
        itemIds: [
          f.preview.items.find((entry) => entry.type === 'http')?.itemId,
        ],
      })
    ).rejects.toThrow('expiredPreview')
    const run = await f.service.commit({
      previewId: next?.previewId,
      itemIds: [f.request.itemId],
    })
    await vi.waitFor(() =>
      expect(f.service.getRun(run.runId).stage).toBe('completed')
    )
    expect(f.service.getRun(run.runId).imported).toBe(1)
    const task = f.db.getAllTasks()[0]
    expect(task.task.torrentMetaPath).toMatch(
      /authorized-torrents[/\\][a-f\d]{64}\.torrent$/
    )
    expect(await readFile(task.task.torrentMetaPath ?? '')).toEqual(original)
    expect(await readFile(f.metadata)).toEqual(original)
    expect(task.task.isPrivate).toBe(true)
    expect(task.task.trackers[0][0]).toContain('127.0.0.1')
  })

  it('cancel leaves the current preview and all selections usable', async () => {
    const f = await fixture()
    await expect(
      f.service.authorizeMetadata(f.request, async () => null)
    ).resolves.toBeNull()
    const http = f.preview.items.find((entry) => entry.type === 'http')
    const run = await f.service.commit({
      previewId: f.preview.previewId,
      itemIds: [http?.itemId],
    })
    await vi.waitFor(() =>
      expect(f.service.getRun(run.runId).stage).toBe('completed')
    )
    expect(f.service.getRun(run.runId).imported).toBe(1)
  })

  it('rejects incorrect bytes for a SHA1-named v1 reference without invalidating the preview', async () => {
    const f = await fixture()
    const wrong = path.join(f.downloads, 'wrong.torrent')
    const bytes = Buffer.from(await readFile(f.metadata))
    bytes[bytes.indexOf(Buffer.from('127.0.0.1'))] = '2'.charCodeAt(0)
    await writeFile(wrong, bytes)
    await expect(
      f.service.authorizeMetadata(f.request, async () => wrong)
    ).rejects.toThrow('metadataMismatch')
    const next = await f.service.authorizeMetadata(
      f.request,
      async () => f.metadata
    )
    expect(
      next?.items.find((entry) => entry.itemId === f.request.itemId)?.selectable
    ).toBe(true)
  })

  it('rejects a source saved while the native picker was open', async () => {
    const f = await fixture()
    await expect(
      f.service.authorizeMetadata(f.request, async () => {
        const session = path.join(f.profile, 'download.session')
        await writeFile(
          session,
          (await readFile(session, 'utf8')).replace('pause=true', 'pause=false')
        )
        return f.metadata
      })
    ).rejects.toThrow('changedSource')
    const scan = await f.service.scan(f.source.sourceHandle)
    expect(scan.items.find((entry) => entry.type === 'bt')?.selectable).toBe(
      false
    )
  })

  it('checks preview expiry before and after choosing a file', async () => {
    const f = await fixture()
    await expect(
      f.service.authorizeMetadata(f.request, async () => {
        f.expire()
        return f.metadata
      })
    ).rejects.toThrow('expiredPreview')
    const choose = vi.fn(async () => f.metadata)
    await expect(
      f.service.authorizeMetadata(f.request, choose)
    ).rejects.toThrow('expiredPreview')
    expect(choose).not.toHaveBeenCalled()
  })

  it('rejects a replaced authorized inode even when replacement bytes are identical', async () => {
    const f = await fixture()
    const next = await f.service.authorizeMetadata(
      f.request,
      async () => f.metadata
    )
    const bytes = await readFile(f.metadata)
    await rename(f.metadata, `${f.metadata}.original`)
    await writeFile(f.metadata, bytes)
    await expect(
      f.service.commit({
        previewId: next?.previewId,
        itemIds: [f.request.itemId],
      })
    ).rejects.toThrow('changedSource')
    expect(f.db.getAllTasks()).toEqual([])
    const rescanned = await f.service.scan(f.source.sourceHandle)
    expect(
      rescanned.items.find((entry) => entry.itemId === f.request.itemId)
    ).toMatchObject({ selectable: false, reason: 'metadata-required' })
    const recovered = await f.service.authorizeMetadata(
      { ...f.request, previewId: rescanned.previewId },
      async () => f.metadata
    )
    expect(
      recovered?.items.find((entry) => entry.itemId === f.request.itemId)
        ?.selectable
    ).toBe(true)
  })

  it('authorizes one chosen file without granting adjacent referenced torrent files', async () => {
    const f = await fixture()
    const source = await authorizeLegacySource(f.profile)
    const first = await scanLegacySource(source, () => false)
    const bt = first.candidates.find((entry) => entry.item.type === 'bt')
    if (!bt?.torrentReferencePath) throw new Error('Missing reference')
    const grant = await authorizeLegacyTorrent(
      f.metadata,
      bt.torrentReferencePath
    )
    const sibling = path.join(f.downloads, 'ungranted.torrent')
    await writeFile(sibling, await readFile(f.metadata))
    const session = path.join(f.profile, 'download.session')
    await writeFile(
      session,
      (await readFile(session, 'utf8')) +
        `\n${sibling}\n gid=2222333344445555\n dir=${f.downloads}\n select-file=1\n`
    )
    const scan = await scanLegacySource(
      source,
      () => false,
      new Map([[bt.entry.digest, grant]])
    )
    expect(
      scan.candidates.find((entry) => entry.entry.gid === '2222333344445555')
        ?.item
    ).toMatchObject({ selectable: false, reason: 'metadata-required' })
    expect(
      scan.files.filter((file) =>
        file.relativePath.startsWith('authorized-torrents/')
      )
    ).toHaveLength(1)
  })

  it('rejects symbolic and hard linked picker targets', async () => {
    const f = await fixture()
    const alias = path.join(f.downloads, 'alias.torrent')
    await symlink(f.metadata, alias)
    await expect(
      f.service.authorizeMetadata(f.request, async () => alias)
    ).rejects.toThrow('unsafeSource')
    await rm(alias)
    await link(f.metadata, alias)
    await expect(
      f.service.authorizeMetadata(f.request, async () => alias)
    ).rejects.toThrow('unsafeSource')
  })

  it('releases a pending picker on drain without mutating grants after shutdown', async () => {
    const f = await fixture()
    let entered = false
    const admission = f.service.authorizeMetadata(f.request, async () => {
      entered = true
      return new Promise<string>(() => {})
    })
    await vi.waitFor(() => expect(entered).toBe(true))
    await f.service.drain()
    await expect(admission).resolves.toBeNull()
    expect(f.db.getAllTasks()).toEqual([])
  })

  it('rejects concurrent metadata admissions before opening a second picker', async () => {
    const f = await fixture()
    let entered = false
    const first = f.service.authorizeMetadata(f.request, async () => {
      entered = true
      return new Promise<string>(() => {})
    })
    await vi.waitFor(() => expect(entered).toBe(true))
    const choose = vi.fn(async () => f.metadata)
    await expect(
      f.service.authorizeMetadata(f.request, choose)
    ).rejects.toThrow('busy')
    expect(choose).not.toHaveBeenCalled()
    await f.service.drain()
    await expect(first).resolves.toBeNull()
  })
})
