import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { LegacyBtActivationService } from '@core/legacy-import/bt-activation-service'
import { LegacyImportService } from '@core/legacy-import/import-service'
import { MotrixDatabase } from '@core/session/motrix-database'
import { TaskManager } from '@core/task/task-manager'
import { vi } from 'vitest'

/** Actual v1 metadata/control snapshots; deterministic payloads recreated from the recorded recipe. */
export async function legacyBtActivationFixture(adapter: EngineAdapter) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'motrix-bt-activation-'))
  )
  await cp(path.resolve('tests/fixtures/legacy-v1/generated'), root, {
    recursive: true,
  })
  const profile = path.join(root, 'profile')
  const downloads = path.join(root, 'downloads')
  for (const name of ['download.session', 'system.json']) {
    const filename = path.join(profile, name)
    await writeFile(
      filename,
      (await readFile(filename, 'utf8'))
        .replaceAll('__FIXTURE_ROOT__', profile)
        .replaceAll('__FIXTURE_DOWNLOADS__', downloads)
        .replaceAll('__FIXTURE_HTTP_PORT__', '18080')
    )
  }
  await mkdir(path.join(downloads, 'fixture-bundle'))
  for (const [name, byte] of [
    ['first.bin', 1],
    ['second.bin', 2],
  ] as const)
    await writeFile(
      path.join(downloads, 'fixture-bundle', name),
      Buffer.alloc(16384, byte),
      { mode: 0o600 }
    )
  const db = new MotrixDatabase(path.join(root, 'motrix.db'))
  db.init()
  const taskManager = new TaskManager()
  const importer = new LegacyImportService({
    db,
    taskManager,
    backupRoot: path.join(root, 'backups'),
    isProcessRunning: () => false,
    publishTasks: vi.fn(),
  })
  const source = await importer.addSource(profile)
  const preview = await importer.scan(source.sourceHandle)
  const item = preview.items.find((entry) => entry.type === 'bt')
  if (!item) throw new Error('No BT fixture')
  const next = await importer.authorizeMetadata(
    { previewId: preview.previewId, itemId: item.itemId },
    async () =>
      path.join(downloads, 'a16dc78c94ce589ed4666ab32285f2d188edf26f.torrent')
  )
  if (!next) throw new Error('No authorized preview')
  const run = await importer.commit({
    previewId: next.previewId,
    itemIds: [item.itemId],
  })
  await vi.waitFor(() => expectCompleted())
  function expectCompleted() {
    if (importer.getRun(run.runId).stage !== 'completed')
      throw new Error('Import pending')
  }
  const taskId = db.getAllTasks()[0].task.motrixId
  const publishTasks = vi.fn()
  const deps = {
    db,
    taskManager,
    adapter,
    backupRoot: path.join(root, 'backups'),
    isProcessRunning: vi.fn(() => false),
    publishTasks,
    runTaskMutation: async <T>(
      _ids: readonly string[],
      operation: () => Promise<T>
    ) => operation(),
    runExclusivePersistence: async <T>(operation: () => T | Promise<T>) =>
      operation(),
  }
  const service = new LegacyBtActivationService(deps)
  return {
    root,
    profile,
    downloads,
    taskId,
    db,
    taskManager,
    service,
    deps,
    importer,
    dispose: async () => {
      await service.drain()
      await importer.drain()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
