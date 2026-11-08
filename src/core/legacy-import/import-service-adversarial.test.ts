// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MotrixDatabase } from '@core/session/motrix-database'
import { TaskManager } from '@core/task/task-manager'
import { TaskStatus, TaskType } from '@shared/types/task'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LegacyImportService,
  type LegacyImportServiceDeps,
} from './import-service'
import type { LegacySnapshot } from './source-scanner'

const cleanups: Array<() => Promise<void>> = []

async function fixture(
  count = 1,
  overrides: Partial<LegacyImportServiceDeps> = {}
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'legacy-import-service-'))
  )
  const sourceRoot = path.join(root, 'legacy')
  await mkdir(sourceRoot)
  const downloads = path.join(root, 'downloads')
  await mkdir(downloads)
  await writeFile(path.join(downloads, 'file-0.zip'), 'original payload')
  await writeFile(
    path.join(sourceRoot, 'user.json'),
    JSON.stringify({ theme: 'auto' })
  )
  await writeFile(
    path.join(sourceRoot, 'system.json'),
    JSON.stringify({ dir: downloads })
  )
  const sessionPath = path.join(sourceRoot, 'download.session')
  await writeFile(
    sessionPath,
    Array.from(
      { length: count },
      (_, i) =>
        `https://example.test/file-${i}.zip\t\n gid=${(i + 1).toString(16).padStart(16, '0')}\n out=file-${i}.zip\n`
    ).join('')
  )
  const db = new MotrixDatabase(path.join(root, 'motrix.db'))
  db.init()
  const taskManager = new TaskManager()
  const deps: LegacyImportServiceDeps = {
    db,
    taskManager,
    backupRoot: path.join(root, 'backups'),
    isProcessRunning: () => false,
    publishTasks: vi.fn(),
    ...overrides,
  }
  const service = new LegacyImportService(deps)
  cleanups.push(async () => {
    await service.drain()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const source = await service.addSource(sourceRoot)
  const preview = await service.scan(source.sourceHandle)
  const request = {
    previewId: preview.previewId,
    itemIds: preview.items
      .filter((item) => item.selectable)
      .map((item) => item.itemId),
  }
  return {
    root,
    sourceRoot,
    downloads,
    sessionPath,
    db,
    taskManager,
    service,
    source,
    preview,
    request,
    deps,
  }
}

async function completed(service: LegacyImportService, runId: string) {
  await expect
    .poll(() => service.getRun(runId).stage)
    .toMatch(/^(completed|failed|cancelled)$/)
  return service.getRun(runId)
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function previewCache(service: LegacyImportService) {
  // Observe ownership directly: GC timing and process RSS are nondeterministic.
  return Reflect.get(service, 'previews') as Map<
    string,
    {
      snapshot: LegacySnapshot | null
      dto: { items: unknown[] }
    }
  >
}

describe('legacy preview memory ownership', () => {
  it('cleans up admission ownership even when persisting its failure report also fails', async () => {
    const f = await fixture()
    const target = f.service as unknown as {
      backup(): Promise<string>
      saveReport(): void
    }
    vi.spyOn(target, 'backup').mockRejectedValueOnce(new Error('backup failed'))
    const reportFailure = new Error('report persistence failed')
    vi.spyOn(target, 'saveReport').mockImplementationOnce(() => {
      throw reportFailure
    })
    await expect(f.service.commit(f.request)).rejects.toBe(reportFailure)
    expect(previewCache(f.service).has(f.preview.previewId)).toBe(false)
    await expect(f.service.scan(f.source.sourceHandle)).resolves.toMatchObject({
      sourceHandle: f.source.sourceHandle,
    })
  })
  it('expires raw snapshots without another scan', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const f = await fixture()
    expect(
      previewCache(f.service).get(f.preview.previewId)?.snapshot
    ).toBeTruthy()
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1)
    expect(previewCache(f.service).size).toBe(0)
    await expect(f.service.commit(f.request)).rejects.toThrow('expiredPreview')
  })

  it('retires completed snapshots while preserving duplicate commit results', async () => {
    const f = await fixture()
    const run = await f.service.commit(f.request)
    await completed(f.service, run.runId)
    expect(previewCache(f.service).get(f.preview.previewId)).toMatchObject({
      snapshot: null,
      dto: { items: [] },
    })
    expect((await f.service.commit(f.request)).runId).toBe(run.runId)
    f.service.releasePreview(f.preview.previewId)
    expect(previewCache(f.service).size).toBe(0)
    expect((await f.service.retry(run.runId)).runId).toBe(run.runId)
  })

  it('releases cancelled snapshots and retries from the lightweight source index', async () => {
    const f = await fixture(2)
    const run = await f.service.commit(f.request)
    f.service.cancel(run.runId)
    await completed(f.service, run.runId)
    expect(
      previewCache(f.service).get(f.preview.previewId)?.snapshot
    ).toBeNull()
    f.service.releasePreview(f.preview.previewId)
    const retried = await f.service.retry(run.runId)
    expect((await completed(f.service, retried.runId)).imported).toBe(2)
  })

  it('does not interrupt an admitted commit when its UI releases the preview', async () => {
    const f = await fixture()
    const accepting = f.service.commit(f.request)
    f.service.releasePreview(f.preview.previewId)
    const run = await accepting
    expect((await completed(f.service, run.runId)).imported).toBe(1)
    expect(previewCache(f.service).size).toBe(0)
  })

  it('rejects overlapping scans and drains the admitted scan before clearing state', async () => {
    const f = await fixture()
    const scanning = f.service.scan(f.source.sourceHandle)
    await expect(f.service.scan(f.source.sourceHandle)).rejects.toThrow('busy')
    const rejected = expect(scanning).rejects.toThrow('busy')
    await f.service.drain()
    await rejected
    expect(previewCache(f.service).size).toBe(0)
  })

  it('enforces the raw-byte budget before the four-preview count limit', async () => {
    const f = await fixture()
    const original = previewCache(f.service).get(f.preview.previewId)?.snapshot
    expect(original).toBeTruthy()
    const bytes = Buffer.alloc(24 * 1024 * 1024)
    const scanSource = vi
      .spyOn(
        f.service as unknown as {
          scanSource(): Promise<LegacySnapshot>
        },
        'scanSource'
      )
      .mockImplementation(async () => ({
        ...original!,
        candidates: [],
        files: [{ relativePath: 'fixture', digest: 'fixture', bytes }],
      }))
    const first = await f.service.scan(f.source.sourceHandle)
    await f.service.scan(f.source.sourceHandle)
    await f.service.scan(f.source.sourceHandle)
    expect(previewCache(f.service).has(first.previewId)).toBe(false)
    expect(previewCache(f.service).size).toBe(2)
    scanSource.mockRestore()
  })
})

describe('legacy import service adversarial acceptance', () => {
  it('returns the authorized data path for discovered and reused sources', async () => {
    const f = await fixture()
    expect(f.source.dataPath).toBe(f.sourceRoot)
    expect(f.service.getSourcePath(f.source.sourceHandle)).toBe(f.sourceRoot)
    expect(() => f.service.getSourcePath('unknown')).toThrow(
      'sourceNotAuthorized'
    )
    expect(await f.service.addSource(f.sourceRoot)).toEqual(f.source)
    expect(await f.service.discover([f.sourceRoot])).toEqual([f.source])
  })

  it('discovers and reauthorizes a large malformed session without parsing tasks or checking a PID', async () => {
    const running = vi.fn(() => false)
    const f = await fixture(1, { isProcessRunning: running })
    await writeFile(f.sessionPath, Buffer.alloc(4 * 1024 * 1024))
    await writeFile(path.join(f.sourceRoot, 'engine.pid'), '123')
    running.mockClear()
    expect(await f.service.discover([f.sourceRoot])).toEqual([f.source])
    expect(await f.service.addSource(f.sourceRoot)).toEqual(f.source)
    expect(running).not.toHaveBeenCalled()
    await expect(f.service.scan(f.source.sourceHandle)).rejects.toThrow(
      'legacyImport.invalidSource'
    )
    expect(running).toHaveBeenCalledWith(123)
  })

  it('does not discover or authorize a missing or symlinked profile file', async () => {
    const f = await fixture()
    const user = path.join(f.sourceRoot, 'user.json')
    await rm(user)
    expect(await f.service.discover([f.sourceRoot])).toEqual([])
    await expect(f.service.addSource(f.sourceRoot)).rejects.toThrow(
      'legacyImport.invalidSource'
    )
    const outside = path.join(f.root, 'outside-user.json')
    await writeFile(outside, '{"theme":"auto"}')
    await symlink(outside, user)
    expect(await f.service.discover([f.sourceRoot])).toEqual([])
    await expect(f.service.addSource(f.sourceRoot)).rejects.toThrow(
      'legacyImport.unsafeSource'
    )
  })

  it('shows the original save directories in previews and persisted reports', async () => {
    const f = await fixture(2)
    const other = path.join(f.root, 'other-downloads')
    await writeFile(
      f.sessionPath,
      [
        'https://example.test/file-0.zip\n out=file-0.zip\n',
        `https://example.test/file-1.zip\n out=file-1.zip\n dir=${other}\n`,
        'https://example.test/invalid.zip\n out=invalid.zip\n dir=relative-folder\n',
        `${path.join(f.root, 'outside.torrent')}\n`,
      ].join('')
    )
    const preview = await f.service.scan(f.source.sourceHandle)
    expect(preview.items.map((item) => item.saveDir)).toEqual([
      f.downloads,
      other,
      null,
      f.downloads,
    ])
    const run = await f.service.commit({
      previewId: preview.previewId,
      itemIds: preview.items
        .filter((item) => item.selectable)
        .map((item) => item.itemId),
    })
    const report = await completed(f.service, run.runId)
    expect(report.imported).toBe(2)
    expect(report.items.map((item) => item.saveDir)).toEqual([
      f.downloads,
      other,
      null,
      f.downloads,
    ])
    expect(
      f.db
        .getAllTasks()
        .map(({ task }) => task.saveDir)
        .sort()
    ).toEqual([f.downloads, other].sort())
    // Displaying a directory does not probe or create it.
    await expect(stat(other)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains committed batches and retries only the failed batch', async () => {
    const f = await fixture(101)
    const save = f.db.saveLegacyImportBatch.bind(f.db)
    let calls = 0
    vi.spyOn(f.db, 'saveLegacyImportBatch').mockImplementation((...args) => {
      if (++calls === 2) throw new Error('injected second batch failure')
      return save(...args)
    })
    const run = await f.service.commit(f.request)
    const first = await completed(f.service, run.runId)
    expect(first.imported).toBe(100)
    expect(
      first.items.filter((item) => item.outcome === 'failed')
    ).toHaveLength(1)
    const retry = await f.service.retry(run.runId)
    const second = await completed(f.service, retry.runId)
    expect(second.imported).toBe(1)
    expect(f.db.getAllTasks()).toHaveLength(101)
    expect(
      new Set(f.db.getAllTasks().map(({ task }) => task.finalPath)).size
    ).toBe(101)
  })

  it('keeps cancellation at a batch boundary and preserves committed items', async () => {
    const f = await fixture(101)
    let runId = ''
    f.deps.publishTasks = () => {
      f.service.cancel(runId)
    }
    const run = await f.service.commit(f.request)
    runId = run.runId
    const report = await completed(f.service, runId)
    expect(report).toMatchObject({
      stage: 'cancelled',
      imported: 100,
      processed: 100,
    })
    expect(f.db.getAllTasks()).toHaveLength(100)
    expect(
      report.items.filter((item) => item.outcome === 'unprocessed')
    ).toHaveLength(1)
  })

  it('does not revive a deleted GID-less entry when v1 rewrites its pause option', async () => {
    const f = await fixture()
    await writeFile(
      f.sessionPath,
      'https://example.test/file-0.zip\n out=file-0.zip\n pause=true\n'
    )
    const preview = await f.service.scan(f.source.sourceHandle)
    const run = await f.service.commit({
      previewId: preview.previewId,
      itemIds: preview.items.map((item) => item.itemId),
    })
    const report = await completed(f.service, run.runId)
    const id = report.items[0].taskId
    expect(id).toBeTruthy()
    f.db.deleteTask(id as string)
    await writeFile(
      f.sessionPath,
      'https://example.test/file-0.zip\n out=file-0.zip\n pause=false\n'
    )
    const updated = await f.service.scan(f.source.sourceHandle)
    expect(updated.items[0]).toMatchObject({
      selectable: false,
      reason: 'deleted-import',
    })
  })

  it('rechecks source changes after waiting for the persistence lane', async () => {
    const f = await fixture()
    f.service.setPersistenceLane(async (operation) => {
      await writeFile(
        f.sessionPath,
        'https://example.test/changed.zip\n out=changed.zip\n'
      )
      return operation()
    })
    const run = await f.service.commit(f.request)
    await completed(f.service, run.runId)
    expect(f.db.getAllTasks()).toHaveLength(0)
  })

  it('commits paused records and private backups without altering payload or source files', async () => {
    const f = await fixture()
    const before = await readFile(f.sessionPath)
    const run = await f.service.commit(f.request)
    const report = await completed(f.service, run.runId)
    expect(report.imported).toBe(1)
    const [task] = f.taskManager.getAll()
    expect(task.status).toBe(TaskStatus.Paused)
    expect(task.engineTaskId).toBe('')
    expect(task.downloadedBytes).toBe(0)
    expect(task.instances.every((instance) => !instance.gid)).toBe(true)
    expect(await readFile(f.sessionPath)).toEqual(before)
    expect(await readFile(path.join(f.downloads, 'file-0.zip'), 'utf8')).toBe(
      'original payload'
    )
    const backup = path.join(f.deps.backupRoot, run.runId)
    expect(await readFile(path.join(backup, 'download.session'))).toEqual(
      before
    )
    if (process.platform !== 'win32') {
      expect((await stat(backup)).mode & 0o777).toBe(0o700)
      expect(
        (await stat(path.join(backup, 'download.session'))).mode & 0o777
      ).toBe(0o600)
    }
  })

  it('imports request-dependent HTTP records inactive without persisting request secrets', async () => {
    const f = await fixture()
    const session = [
      'https://example.test/file-0.zip',
      ' gid=0000000000000001',
      ' out=file-0.zip',
      ' pause=true',
      ' header=Authorization: Bearer LEGACY_AUTH_SECRET',
      ' header=Cookie: session=LEGACY_COOKIE_SECRET',
      ' load-cookies=/private/LEGACY_COOKIE_FILE_SECRET',
      ' on-download-complete=LEGACY_COMMAND_SECRET',
      '',
    ].join('\n')
    await writeFile(f.sessionPath, session)
    await writeFile(
      path.join(f.sourceRoot, 'system.json'),
      JSON.stringify({
        dir: f.downloads,
        'all-proxy': 'http://user:LEGACY_PROXY_SECRET@proxy.example:8080',
      })
    )
    const preview = await f.service.scan(f.source.sourceHandle)
    expect(preview.items[0]).toMatchObject({
      type: 'http',
      selectable: true,
      reason: 'request-settings-required',
      requestOptions: ['header'],
      ignoredOptions: expect.arrayContaining([
        'load-cookies',
        'on-download-complete',
      ]),
    })
    const run = await f.service.commit({
      previewId: preview.previewId,
      itemIds: [preview.items[0].itemId],
    })
    const report = await completed(f.service, run.runId)
    expect(report.imported).toBe(1)
    const [task] = f.taskManager.getAll()
    expect(task.status).toBe(TaskStatus.Paused)
    expect(task.instances[0].gid).toBeNull()
    expect(task.instances[0].payload.legacyImport).toMatchObject({
      activation: 'inactive',
      storagePolicy: 'legacy-read-only',
      reason: 'request-settings-required',
      requestOptions: ['header'],
      ignoredOptions: expect.arrayContaining([
        'load-cookies',
        'on-download-complete',
      ]),
    })
    const persisted = JSON.stringify({
      tasks: f.db.getAllTasks(),
      report: f.service.getRun(run.runId),
      preview,
    })
    for (const secret of [
      'LEGACY_AUTH_SECRET',
      'LEGACY_COOKIE_SECRET',
      'LEGACY_PROXY_SECRET',
      'LEGACY_COOKIE_FILE_SECRET',
      'LEGACY_COMMAND_SECRET',
    ])
      expect(persisted).not.toContain(secret)
    expect(await readFile(f.sessionPath, 'utf8')).toBe(session)
    expect(await readFile(path.join(f.downloads, 'file-0.zip'), 'utf8')).toBe(
      'original payload'
    )
    expect(
      await readFile(
        path.join(f.deps.backupRoot, run.runId, 'download.session'),
        'utf8'
      )
    ).toBe(session)
    expect(
      (await f.service.scan(f.source.sourceHandle)).items[0]
    ).toMatchObject({
      selectable: false,
      reason: 'already-imported',
    })
  })

  it.each(['unnamed', 'same display name', 'same output hint'] as const)(
    'imports distinct magnets sharing a directory and %s without claiming files',
    async (kind) => {
      const f = await fixture()
      const count = kind === 'unnamed' ? 101 : 2 // Cross the 100-record batch boundary.
      const name = kind === 'unnamed' ? 'Magnet' : 'shared'
      const original = path.join(f.downloads, name)
      await writeFile(original, 'unrelated existing bytes')
      const uris = Array.from(
        { length: count },
        (_, i) =>
          `magnet:?xt=urn:btih:${(i + 1).toString(16).padStart(40, '0')}${kind === 'same display name' ? '&dn=shared' : ''}`
      )
      await writeFile(
        f.sessionPath,
        uris
          .map(
            (uri, i) =>
              `${uri}\n gid=${(i + 1).toString(16).padStart(16, '0')}\n${kind === 'same output hint' ? ' out=shared\n' : ''}`
          )
          .join('')
      )
      const preview = await f.service.scan(f.source.sourceHandle)
      expect(preview.items.filter((item) => item.selectable)).toHaveLength(
        count
      )
      const run = await f.service.commit({
        previewId: preview.previewId,
        itemIds: preview.items.map((item) => item.itemId),
      })
      expect(await completed(f.service, run.runId)).toMatchObject({
        stage: 'completed',
        imported: count,
      })
      const tasks = f.db.getAllTasks()
      expect(tasks).toHaveLength(count)
      expect(
        tasks
          .flatMap(({ instances }) =>
            instances.flatMap((instance) => instance.uris)
          )
          .sort()
      ).toEqual([...uris].sort())
      for (const { task, instances } of tasks) {
        expect(task.taskType).toBe(TaskType.Magnet)
        expect(task.aggStatus).toBe(TaskStatus.Paused)
        expect(task.torrentMetaPath).toBeNull()
        expect(instances[0].gid).toBeNull()
      }
      expect(await readFile(original, 'utf8')).toBe('unrelated existing bytes')
      const repeated = await f.service.scan(f.source.sourceHandle)
      expect(
        repeated.items.every(
          (item) => !item.selectable && item.reason === 'already-imported'
        )
      ).toBe(true)
    }
  )

  it('does not let an earlier imported magnet hint block later magnets or real HTTP paths', async () => {
    const f = await fixture()
    const first = `magnet:?xt=urn:btih:${'1'.repeat(40)}\n gid=1111111111111111\n`
    await writeFile(f.sessionPath, first)
    let preview = await f.service.scan(f.source.sourceHandle)
    let run = await f.service.commit({
      previewId: preview.previewId,
      itemIds: [preview.items[0].itemId],
    })
    expect((await completed(f.service, run.runId)).imported).toBe(1)
    await writeFile(
      f.sessionPath,
      first +
        `magnet:?xt=urn:btih:${'2'.repeat(40)}\n gid=2222222222222222\nhttps://example.test/Magnet\n gid=3333333333333333\n`
    )
    const restarted = new LegacyImportService(f.deps)
    const source = await restarted.addSource(f.sourceRoot)
    preview = await restarted.scan(source.sourceHandle)
    expect(preview.items.map((item) => item.selectable)).toEqual([
      false,
      true,
      true,
    ])
    run = await restarted.commit({
      previewId: preview.previewId,
      itemIds: preview.items
        .filter((item) => item.selectable)
        .map((item) => item.itemId),
    })
    expect(await completed(restarted, run.runId)).toMatchObject({
      stage: 'completed',
      imported: 2,
    })
    expect(f.db.getAllTasks()).toHaveLength(3)
    await restarted.drain()
    // A real HTTP target continues to reserve its path; another magnet is only a record.
    await writeFile(
      f.sessionPath,
      `https://other.test/Magnet\n gid=4444444444444444\nmagnet:?xt=urn:btih:${'3'.repeat(40)}\n gid=5555555555555555\n`
    )
    preview = await f.service.scan(f.source.sourceHandle)
    expect(preview.items[0]).toMatchObject({
      selectable: false,
      reason: 'path-conflict',
    })
    expect(preview.items[1]).toMatchObject({
      selectable: true,
      reason: 'metadata-required',
    })
  })

  it('preserves GID-less magnet deletion identity when v1 rewrites its pause flag', async () => {
    const f = await fixture()
    const uri = `magnet:?xt=urn:btih:${'1'.repeat(40)}`
    await writeFile(f.sessionPath, `${uri}\n pause=true\n`)
    const preview = await f.service.scan(f.source.sourceHandle)
    const run = await f.service.commit({
      previewId: preview.previewId,
      itemIds: [preview.items[0].itemId],
    })
    const report = await completed(f.service, run.runId)
    f.db.deleteTask(report.items[0].taskId!)
    await writeFile(
      f.sessionPath,
      `${uri}\n pause=false\nmagnet:?xt=urn:btih:${'2'.repeat(40)}\n`
    )
    const next = await f.service.scan(f.source.sourceHandle)
    expect(next.items[0]).toMatchObject({
      itemId: preview.items[0].itemId,
      selectable: false,
      reason: 'deleted-import',
    })
    expect(next.items[1]).toMatchObject({
      selectable: true,
      reason: 'metadata-required',
    })
  })

  it('imports a proxy-dependent magnet inactive with stripped option names and no request secrets', async () => {
    const f = await fixture()
    const session = [
      'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=bundle',
      ' gid=0000000000000002',
      ' all-proxy-user=LEGACY_PROXY_USER',
      ' header=Cookie: LEGACY_BT_COOKIE_SECRET',
      ' rpc-secret=LEGACY_RPC_SECRET',
      '',
    ].join('\n')
    await writeFile(f.sessionPath, session)
    await writeFile(
      path.join(f.sourceRoot, 'system.json'),
      JSON.stringify({
        dir: f.downloads,
        'all-proxy': 'http://proxy.example:8080',
        'all-proxy-passwd': 'LEGACY_PROXY_PASSWORD',
      })
    )
    const preview = await f.service.scan(f.source.sourceHandle)
    expect(preview.items[0]).toMatchObject({
      type: 'magnet',
      name: 'bundle',
      selectable: true,
      reason: 'metadata-required',
      ignoredOptions: expect.arrayContaining([
        'header',
        'rpc-secret',
        'all-proxy',
        'all-proxy-user',
        'all-proxy-passwd',
      ]),
    })
    const run = await f.service.commit({
      previewId: preview.previewId,
      itemIds: [preview.items[0].itemId],
    })
    const report = await completed(f.service, run.runId)
    expect(report.imported).toBe(1)
    const [task] = f.taskManager.getAll()
    expect(task.status).toBe(TaskStatus.Paused)
    expect(task.instances[0].gid).toBeNull()
    expect(task.instances[0].payload.legacyImport).toMatchObject({
      activation: 'inactive',
      storagePolicy: 'legacy-read-only',
      ignoredOptions: expect.arrayContaining([
        'header',
        'rpc-secret',
        'all-proxy',
        'all-proxy-user',
        'all-proxy-passwd',
      ]),
    })
    const persisted = JSON.stringify({
      tasks: f.db.getAllTasks(),
      preview,
      report,
    })
    expect(persisted).not.toMatch(
      /LEGACY_PROXY_USER|LEGACY_BT_COOKIE_SECRET|LEGACY_RPC_SECRET|LEGACY_PROXY_PASSWORD|proxy\.example/
    )
    expect(await readFile(f.sessionPath, 'utf8')).toBe(session)
  })

  it('rejects a stale preview before committing records', async () => {
    const f = await fixture()
    await writeFile(
      f.sessionPath,
      'https://example.test/changed.zip\n out=changed.zip\n'
    )
    await expect(f.service.commit(f.request)).rejects.toThrow()
    expect(f.db.getAllTasks()).toHaveLength(0)
  })

  it('rejects a now-running old engine even if preview observed it stopped', async () => {
    let running = false
    const f = await fixture(1, { isProcessRunning: () => running })
    await writeFile(path.join(f.sourceRoot, 'engine.pid'), '12345')
    const preview = await f.service.scan(f.source.sourceHandle)
    running = true
    await expect(
      f.service.commit({
        previewId: preview.previewId,
        itemIds: preview.items.map((item) => item.itemId),
      })
    ).rejects.toThrow()
    expect(f.db.getAllTasks()).toHaveLength(0)
  })

  it('admits only one of two concurrent commits and persists one record', async () => {
    const f = await fixture()
    const results = await Promise.allSettled([
      f.service.commit(f.request),
      f.service.commit(f.request),
    ])
    const accepted = results.filter((result) => result.status === 'fulfilled')
    expect(accepted).toHaveLength(1)
    if (accepted[0].status === 'fulfilled')
      await completed(f.service, accepted[0].value.runId)
    expect(f.db.getAllTasks()).toHaveLength(1)
  })

  it('keeps the deletion tombstone across importer restarts', async () => {
    const f = await fixture()
    const run = await f.service.commit(f.request)
    const report = await completed(f.service, run.runId)
    const id = report.items[0].taskId
    expect(id).toBeTruthy()
    f.db.deleteTask(id as string)
    const restarted = new LegacyImportService(f.deps)
    const source = await restarted.addSource(f.sourceRoot)
    const preview = await restarted.scan(source.sourceHandle)
    expect(preview.items[0]).toMatchObject({
      selectable: false,
      reason: 'deleted-import',
    })
  })

  it('refuses a backup root symlink and commits no task', async () => {
    const f = await fixture()
    const outside = path.join(f.root, 'outside')
    await mkdir(outside)
    await symlink(outside, f.deps.backupRoot)
    await expect(f.service.commit(f.request)).rejects.toThrow()
    expect(f.db.getAllTasks()).toHaveLength(0)
    expect(await readdir(outside)).toEqual([])
  })

  it('rolls back task graphs and ledger when the import transaction fails', async () => {
    const f = await fixture()
    f.db.database.exec(
      "CREATE TRIGGER reject_import BEFORE INSERT ON legacy_import_ledger BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
    )
    const run = await f.service.commit(f.request)
    const report = await completed(f.service, run.runId)
    expect(report.imported).toBe(0)
    expect(report.items[0].outcome).toBe('failed')
    expect(f.db.getAllTasks()).toHaveLength(0)
    expect(
      f.db.database.prepare('SELECT * FROM legacy_import_ledger').all()
    ).toHaveLength(0)
  })

  it('does not relabel a durable success as failure when UI publication throws', async () => {
    const f = await fixture(1, {
      publishTasks: () => {
        throw new Error('observer failed')
      },
    })
    const run = await f.service.commit(f.request)
    const report = await completed(f.service, run.runId)
    expect(f.db.getAllTasks()).toHaveLength(1)
    expect(report).toMatchObject({ imported: 1, processed: 1 })
    expect(report.items[0].outcome).toBe('imported')
  })

  it('stops further batches if the source changes after the first batch', async () => {
    let f: Awaited<ReturnType<typeof fixture>>
    let batches = 0
    f = await fixture(101, {
      runExclusivePersistence: async (operation) => {
        const result = await operation()
        if (++batches === 1)
          await writeFile(
            f.sessionPath,
            'https://example.test/changed.zip\n out=changed.zip\n'
          )
        return result
      },
    })
    const run = await f.service.commit(f.request)
    await completed(f.service, run.runId)
    expect(f.db.getAllTasks()).toHaveLength(100)
  })

  it('drains an admitted import before shutdown without committing after drain returns', async () => {
    const f = await fixture()
    let admissionSettled = false
    const committing = f.service
      .commit(f.request)
      .catch(() => null)
      .finally(() => {
        admissionSettled = true
      })
    await f.service.drain()
    expect(admissionSettled).toBe(true)
    const atShutdown = f.db.getAllTasks().length
    const report = await committing
    if (report) await completed(f.service, report.runId)
    expect(f.db.getAllTasks()).toHaveLength(atShutdown)
    expect(atShutdown).toBe(0)
  })
})
