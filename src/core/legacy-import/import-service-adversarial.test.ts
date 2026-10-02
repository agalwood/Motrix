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
import { TaskStatus } from '@shared/types/task'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LegacyImportService,
  type LegacyImportServiceDeps,
} from './import-service'

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
})

describe('legacy import service adversarial acceptance', () => {
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
