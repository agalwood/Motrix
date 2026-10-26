import { execFileSync } from 'node:child_process'
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

function secureWindowsFixture(root: string): void {
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
  execFileSync('icacls.exe', [
    root,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(OI)(CI)F`,
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F',
  ])
  // Hosted runners use an elevated token whose default owner may be Administrators.
  // Production import checks ownership and never changes it; only fixtures do.
  execFileSync('icacls.exe', [root, '/setowner', `*${sid}`, '/T'])
}

/** Actual v1 metadata/control snapshots; deterministic payloads recreated from the recorded recipe. */
export async function legacyBtActivationFixture(
  adapter: EngineAdapter,
  configureProfile?: (profile: string) => Promise<void>
) {
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
    const encodePath = (value: string) =>
      name.endsWith('.json') ? JSON.stringify(value).slice(1, -1) : value
    await writeFile(
      filename,
      (await readFile(filename, 'utf8'))
        .replaceAll('__FIXTURE_ROOT__', encodePath(profile))
        .replaceAll('__FIXTURE_DOWNLOADS__', encodePath(downloads))
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
  await configureProfile?.(profile)
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
  secureWindowsFixture(root)
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
