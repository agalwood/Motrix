import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import {
  type LegacyHttpActivationDeps,
  LegacyHttpActivationService,
} from '@core/legacy-import/http-activation-service'
import { authorizeLegacySource } from '@core/legacy-import/source-scanner'
import { AppliedDownloadProxyPolicy } from '@core/proxy/applied-download-proxy-policy'
import type {
  MotrixDatabase,
  TaskWithInstances,
} from '@core/session/motrix-database'
import { TaskManager } from '@core/task/task-manager'
import { taskRowToDownloadTask } from '@core/task/task-row-to-download-task'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
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
  execFileSync('icacls.exe', [root, '/setowner', `*${sid}`, '/T'])
}

const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
export const LEGACY_HTTP_TOTAL = 4194304
export const LEGACY_HTTP_COMPLETED = 1638400

/** Real legacy HTTP payload/control bytes with an isolated persistence seam. */
export async function legacyHttpActivationFixture(options: {
  adapter: EngineAdapter
  uri?: string
  requestLines?: string
  system?: Record<string, unknown>
  verifier?: LegacyHttpActivationDeps['verifier']
}) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'motrix-http-activation-'))
  )
  const profile = path.join(root, 'profile')
  const downloads = path.join(root, 'downloads')
  const backupRoot = path.join(root, 'backups')
  for (const dir of [profile, downloads, backupRoot])
    await mkdir(dir, { mode: 0o700 })
  const uri = options.uri ?? 'http://127.0.0.1:18080/partial.bin'
  const target = path.join(downloads, 'partial.bin')
  const fixtureRoot = path.resolve(
    'tests/fixtures/legacy-v1/generated/downloads'
  )
  const payload = gunzipSync(
    await readFile(path.join(fixtureRoot, 'partial.bin.gz'))
  )
  const control = await readFile(path.join(fixtureRoot, 'partial.bin.aria2'))
  await writeFile(target, payload, { mode: 0o600 })
  await writeFile(`${target}.aria2`, control, { mode: 0o600 })
  const profiles: Record<string, Buffer> = {
    'download.session': Buffer.from(
      `${uri}\n gid=0123456789abcdef\n dir=${downloads}\n out=partial.bin\n pause=true\n no-netrc=true\n${options.requestLines ?? ''}`
    ),
    'system.json': Buffer.from(
      JSON.stringify({ dir: downloads, ...options.system })
    ),
    'user.json': Buffer.from(JSON.stringify({ locale: 'en-US' })),
  }
  for (const [name, bytes] of Object.entries(profiles))
    await writeFile(path.join(profile, name), bytes)
  secureWindowsFixture(root)
  const source = await authorizeLegacySource(profile)
  const taskId = 'http-legacy-fixture'
  const row: TaskWithInstances = {
    task: {
      motrixId: taskId,
      name: 'partial.bin',
      kind: TaskKind.Direct,
      taskType: TaskType.Http,
      category: null,
      priority: 0,
      tags: null,
      createdAt: 1,
      updatedAt: 1,
      saveDir: downloads,
      finalPath: target,
      finalName: 'partial.bin',
      torrentMetaPath: null,
      infoHash: null,
      totalBytes: 0,
      downloadedBytes: 0,
      sizeWhenDone: 0,
      fileCount: 1,
      isPrivate: false,
      trackers: [],
      pieceLength: 0,
      aggStatus: TaskStatus.Paused,
      finishedAt: null,
      errorMessage: null,
      errorCode: null,
      errorDetailKey: null,
      errorDetailParams: null,
      diagnosisRevision: 0,
      uploadedBytesBaseline: 0,
      source: 'user',
      sourceMeta: null,
    },
    instances: [
      {
        instanceId: 'http-instance',
        motrixId: taskId,
        gid: null,
        phase: TaskInstancePhase.HttpDownload,
        status: TaskStatus.Paused,
        progress: 0,
        totalBytes: 0,
        downloadedBytes: 0,
        uploadedBytes: 0,
        diskPath: target,
        transitionPhase: TransitionPhase.Idle,
        uris: [uri],
        uriHash: null,
        createdAt: 1,
        updatedAt: 1,
        payload: {
          legacyImport: {
            version: 1,
            sourceId: 'source',
            itemKey: 'gid:0123456789abcdef',
            activation: 'inactive',
            storagePolicy: 'legacy-read-only',
            reason: 'verification-required',
            selectionKnown: false,
            selectedFiles: [],
            origin: {
              root: source.root,
              identity: source.identity,
              sessionDigest: hash(profiles['download.session']),
              torrentDigest: null,
              profileFiles: Object.entries(profiles).map(
                ([relativePath, bytes]) => ({
                  relativePath,
                  digest: hash(bytes),
                })
              ),
            },
          },
        },
      },
    ],
  }
  const rows = new Map([[taskId, row]])
  const db = {
    getTask: (id: string) => {
      const current = rows.get(id)
      return current ? structuredClone(current) : undefined
    },
    getAllTasks: () =>
      [...rows.values()].map((current) => structuredClone(current)),
    saveTaskWithInstances: (next: TaskWithInstances) =>
      rows.set(next.task.motrixId, structuredClone(next)),
  } as unknown as MotrixDatabase
  const taskManager = new TaskManager()
  taskManager.set(taskId, taskRowToDownloadTask(row.task, row.instances))
  const proxyPolicy = new AppliedDownloadProxyPolicy({ noProxy: '' })
  const deps: LegacyHttpActivationDeps = {
    proxyPolicy,
    db,
    taskManager,
    adapter: options.adapter,
    backupRoot,
    isProcessRunning: vi.fn(() => false),
    publishTasks: vi.fn(),
    runTaskMutation: async (_ids, operation) => operation(),
    runExclusivePersistence: async (operation) => operation(),
    verifier: options.verifier,
  }
  const service = new LegacyHttpActivationService(deps)
  return {
    proxyPolicy,
    root,
    profile,
    downloads,
    target,
    taskId,
    payload,
    control,
    rows,
    db,
    taskManager,
    deps,
    service,
    dispose: async () => {
      await service.drain()
      await rm(root, { recursive: true, force: true })
    },
  }
}
