import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity/task-activity-service'
import type { Aria2RpcClient } from '@core/engine/aria2/aria2-rpc-client'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import type {
  FinalizeArtifactOperations,
  FinalizeJournalPhase,
  FinalizeJournalRecord,
} from '@core/plugin/finalize/finalize-committer'
import { materializePostDeliveries } from '@core/plugin/post/delivery-materializer'
import { TaskManager } from '@core/task/task-manager'
import { TaskRecoveryServiceImpl } from '@core/task/task-recovery-service'
import { TaskStatus, TransitionPhase } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurableFinalizeRuntime } from './durable-finalize-runtime'
import { TASK_DELETED_FINALIZE_REASON } from './finalize-journal-lifecycle'
import { SqliteFinalizeJournalRepository } from './finalize-journal-repository'
import { MotrixDatabase } from './motrix-database'
import { SessionManager } from './session-manager'

type Phase = FinalizeJournalPhase | 'quarantined'
const phases: Phase[] = [
  'prepared',
  'target_staged',
  'source_preserved',
  'target_installed',
  'db_committed',
  'cleaned',
  'quarantined',
]

describe('task deletion and durable finalize recovery', () => {
  const roots: string[] = []
  const databases = new Set<MotrixDatabase>()

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const db of databases) db.close()
    databases.clear()
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    )
  })

  async function fixture() {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'motrix-finalize-delete-')
    )
    roots.push(root)
    const filename = path.join(root, 'motrix.db')
    const open = () => {
      const db = new MotrixDatabase(filename)
      databases.add(db)
      db.init()
      const tasks = new TaskManager()
      const rpc = {
        tellActive: vi.fn(async () => []),
        tellWaiting: vi.fn(async () => []),
        tellStopped: vi.fn(async () => []),
      } as unknown as Aria2RpcClient
      const session = new SessionManager(tasks, rpc, db, {} as EngineAdapter)
      const fs = {
        identity: vi.fn(async () => null),
        sameFilesystem: vi.fn(async () => false),
        materializePrivate: vi.fn(),
        makeDurable: vi.fn(),
        moveNoReplace: vi.fn(),
        removeKnown: vi.fn(),
      } satisfies FinalizeArtifactOperations
      const runtime = new DurableFinalizeRuntime({
        db: db.database,
        session,
        fs,
      })
      const journals = new SqliteFinalizeJournalRepository(db.database, {
        commitTerminalBoundary: vi.fn(),
      })
      return { db, tasks, session, runtime, journals, fs }
    }
    return { root, open, ...open() }
  }

  function close(db: MotrixDatabase) {
    db.close()
    databases.delete(db)
  }

  async function seed(
    f: Awaited<ReturnType<typeof fixture>>,
    id: string,
    phase: Phase
  ) {
    const sourcePath = path.join(f.root, `${id}.motrix`)
    const targetPath = path.join(f.root, id)
    const task = makeDownloadTask({
      id,
      engineTaskId: '',
      status: TaskStatus.Error,
      transitionPhase: TransitionPhase.Renaming,
      name: id,
      saveDir: f.root,
      diskPath: sourcePath,
      finalPath: targetPath,
      filename: id,
      finalName: id,
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    await f.session.persistTask(task)
    const record: FinalizeJournalRecord = {
      journalId: `plan-${id}`,
      phase: phase === 'quarantined' ? 'prepared' : phase,
      plan: {
        planId: `plan-${id}`,
        taskId: id,
        saveDir: f.root,
        sourcePath,
        targetPath,
        sourceIdentity: {
          kind: 'file',
          size: 1,
          sha256: 'a'.repeat(64),
          platformFileId: `file-${id}`,
        },
        metadataOps: [],
        contributors: [],
      },
      rollbackPath: path.join(f.root, `${id}.rollback`),
      privateTargetPath: path.join(f.root, `${id}.private`),
    }
    // Preserve real checkpoint bytes, including the original phase and paths,
    // even when the database phase changes to a terminal cancellation.
    f.db.database
      .prepare(
        `INSERT INTO plugin_finalize_journals (
          plan_id, task_id, phase, plan_json, source_identity_json,
          quarantine_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1000, 1000)`
      )
      .run(
        record.journalId,
        id,
        phase,
        JSON.stringify(record),
        JSON.stringify(record.plan.sourceIdentity),
        phase === 'quarantined' ? 'compensation failed after rename' : null
      )
    return { task, record }
  }

  function rawJournal(db: MotrixDatabase, id: string) {
    return db.database
      .prepare('SELECT * FROM plugin_finalize_journals WHERE task_id=?')
      .get(id)
  }

  function postState(db: MotrixDatabase) {
    return {
      deliveries: db.database
        .prepare('SELECT * FROM plugin_post_deliveries')
        .all(),
      ledger: db.database
        .prepare('SELECT * FROM plugin_post_quota_ledger')
        .all(),
    }
  }

  for (const deletion of ['single', 'bulk'] as const) {
    it.each(phases)(
      `${deletion} deletion stops %s recovery across restarts`,
      async (phase) => {
        const f = await fixture()
        const { record } = await seed(f, 'deleted', phase)
        const paths = [
          record.plan.sourcePath,
          record.plan.targetPath,
          record.rollbackPath!,
          record.privateTargetPath!,
        ]
        for (const file of paths) await writeFile(file, `preserve:${file}`)
        f.db.durablePostDeliveries.admitMany([postAdmission('deleted')])
        const posts = postState(f.db)
        const before = rawJournal(f.db, 'deleted') as Record<string, unknown>

        if (deletion === 'single') f.db.deleteTask('deleted')
        else f.db.deleteTasks(['deleted', 'deleted'])

        expect(f.db.getTask('deleted')).toBeNull()
        expect(await f.runtime.hasPendingFinalization('deleted')).toBe(false)
        expect(postState(f.db)).toEqual(posts)
        if (phase === 'cleaned') {
          expect(rawJournal(f.db, 'deleted')).toBeUndefined()
        } else {
          expect(rawJournal(f.db, 'deleted')).toEqual({
            ...before,
            phase: 'quarantined',
            quarantine_reason: TASK_DELETED_FINALIZE_REASON,
            updated_at: expect.any(Number),
          })
        }
        close(f.db)

        // Both hosts open MotrixDatabase before filesystem/session recovery.
        // Exercise that order twice, using a real SQLite file and empty engine.
        for (let restart = 0; restart < 2; restart++) {
          const current = f.open()
          await current.runtime.recoverAll()
          await current.session.restore()
          const finalizeTask = vi.fn()
          const persist = vi.fn()
          const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
          const recovery = new TaskRecoveryServiceImpl({
            taskManager: { getAll: () => current.tasks.getAll(), persist },
            adapter: { listActiveAndWaiting: vi.fn(async () => []) },
            fs: {
              pathExists: vi.fn(),
              renameAtomic: vi.fn(),
              removePathRecursive: vi.fn(),
            },
            activityRecorder: NOOP_TASK_ACTIVITY_RECORDER,
            finalizeTask,
            hasPendingFinalization: (id) =>
              current.runtime.hasPendingFinalization(id),
            log,
          })
          expect(await recovery.recoverOnStartup()).toMatchObject({
            totalScanned: 0,
            errors: [],
            warnings: [],
          })
          expect(current.tasks.getAll()).toEqual([])
          expect(current.db.getAllTasks()).toEqual([])
          expect(await current.runtime.hasPendingFinalization('deleted')).toBe(
            false
          )
          expect(await current.journals.listRecoverable()).toEqual([])
          expect(await current.journals.listRecoverable('deleted')).toEqual([])
          for (const operation of Object.values(current.fs))
            expect(operation).not.toHaveBeenCalled()
          expect(finalizeTask).not.toHaveBeenCalled()
          expect(persist).not.toHaveBeenCalled()
          expect(log.error).not.toHaveBeenCalled()
          expect(postState(current.db)).toEqual(posts)
          close(current.db)
        }
        for (const file of paths)
          expect(await readFile(file, 'utf8')).toBe(`preserve:${file}`)
      }
    )

    it(`${deletion} deletion rolls journal changes back with a failed parent delete`, async () => {
      const f = await fixture()
      await seed(f, 'unfinished', 'source_preserved')
      await seed(f, 'finished', 'cleaned')
      const before = f.db.database
        .prepare('SELECT * FROM plugin_finalize_journals ORDER BY task_id')
        .all()
      f.db.database.exec(`CREATE TRIGGER reject_task_delete BEFORE DELETE ON tasks
        WHEN OLD.motrix_id='${deletion === 'single' ? 'unfinished' : 'finished'}'
        BEGIN SELECT RAISE(ABORT, 'delete failed'); END`)
      expect(() =>
        deletion === 'single'
          ? f.db.deleteTask('unfinished')
          : f.db.deleteTasks(['unfinished', 'finished'])
      ).toThrow('delete failed')
      expect(f.db.getAllTasks()).toHaveLength(2)
      expect(
        f.db.database
          .prepare('SELECT * FROM plugin_finalize_journals ORDER BY task_id')
          .all()
      ).toEqual(before)
      expect(await f.runtime.hasPendingFinalization('unfinished')).toBe(true)
    })

    it(`${deletion} deletion preserves journals owned by other tasks`, async () => {
      const f = await fixture()
      await seed(f, 'removed-pending', 'prepared')
      await seed(f, 'removed-cleaned', 'cleaned')
      await seed(f, 'kept-pending', 'prepared')
      await seed(f, 'kept-cleaned', 'cleaned')
      const pending = rawJournal(f.db, 'kept-pending')
      const cleaned = rawJournal(f.db, 'kept-cleaned')
      if (deletion === 'single') {
        f.db.deleteTask('removed-pending')
        f.db.deleteTask('removed-cleaned')
      } else {
        f.db.deleteTasks(['removed-pending', 'removed-cleaned'])
      }
      expect(rawJournal(f.db, 'removed-cleaned')).toBeUndefined()
      expect(await f.runtime.hasPendingFinalization('removed-pending')).toBe(
        false
      )
      expect(rawJournal(f.db, 'kept-pending')).toEqual(pending)
      expect(rawJournal(f.db, 'kept-cleaned')).toEqual(cleaned)
      expect(await f.runtime.hasPendingFinalization('kept-pending')).toBe(true)
      expect(
        f.db
          .getAllTasks()
          .map((pair) => pair.task.motrixId)
          .sort()
      ).toEqual(['kept-cleaned', 'kept-pending'])
    })
  }

  it('repairs legacy orphans, preserves live owners and malformed evidence, and is idempotent', async () => {
    const f = await fixture()
    for (const phase of phases) await seed(f, phase, phase)
    await seed(f, 'live', 'prepared')
    await seed(f, 'malformed', 'prepared')
    f.db.database
      .prepare(
        "UPDATE plugin_finalize_journals SET plan_json='{}' WHERE task_id='malformed'"
      )
      .run()
    const live = rawJournal(f.db, 'live')
    // Simulate a database written by a version that omitted journal cleanup.
    f.db.database.prepare("DELETE FROM tasks WHERE motrix_id <> 'live'").run()
    close(f.db)
    const current = f.open()
    expect(rawJournal(current.db, 'cleaned')).toBeUndefined()
    for (const phase of phases.filter((phase) => phase !== 'cleaned')) {
      expect(rawJournal(current.db, phase)).toMatchObject({
        phase: 'quarantined',
        quarantine_reason: TASK_DELETED_FINALIZE_REASON,
      })
      expect(await current.runtime.hasPendingFinalization(phase)).toBe(false)
    }
    expect(rawJournal(current.db, 'malformed')).toMatchObject({
      plan_json: '{}',
      quarantine_reason: TASK_DELETED_FINALIZE_REASON,
    })
    expect(rawJournal(current.db, 'live')).toEqual(live)
    expect(await current.runtime.hasPendingFinalization('live')).toBe(true)
    expect(
      (await current.journals.listRecoverable()).map((row) => row.plan.taskId)
    ).toEqual(['live'])
    const repaired = current.db.database
      .prepare('SELECT * FROM plugin_finalize_journals ORDER BY task_id')
      .all()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
    current.db.init()
    expect(
      current.db.database
        .prepare('SELECT * FROM plugin_finalize_journals ORDER BY task_id')
        .all()
    ).toEqual(repaired)
  })

  it('does not let a late recovery error reopen a deleted task journal', async () => {
    const f = await fixture()
    const { record } = await seed(f, 'deleted', 'prepared')
    f.db.deleteTask('deleted')
    const cancelled = rawJournal(f.db, 'deleted')
    await f.journals.quarantine(
      record.journalId,
      'compensation failed after rename'
    )
    expect(rawJournal(f.db, 'deleted')).toEqual(cancelled)
    expect(await f.journals.listRecoverable()).toEqual([])
    await expect(
      f.journals.advance(record.journalId, 'cleaned')
    ).rejects.toThrow('quarantined')
    await expect(f.journals.prepare(record)).rejects.toThrow(
      'unfinished finalize journal'
    )
  })

  it('keeps independent post delivery claimable after deleting its task', async () => {
    const f = await fixture()
    await seed(f, 'deleted', 'quarantined')
    f.db.durablePostDeliveries.admitMany([postAdmission('deleted')])
    f.db.deleteTask('deleted')
    const claim = await f.db.durablePostDeliveries.claimNextForPlugin({
      pluginId: 'plugin.example',
      now: 1_000,
      leaseToken: 'lease',
      leaseExpiresAt: 2_000,
      maxAttempts: 12,
      maxActiveAgeMs: 86_400_000,
    })
    expect(claim).toMatchObject({ taskId: 'deleted', status: 'delivering' })
  })
})

function postAdmission(taskId: string) {
  return materializePostDeliveries({
    event: {
      schemaVersion: 1,
      occurrenceId: `occ-${taskId}`,
      taskId,
      occurredAt: 1_000,
      payload: {
        filePath: '/downloads/output.bin',
        task: {
          schemaVersion: 1,
          id: taskId,
          name: 'output.bin',
          type: 'http',
          kind: 'direct',
          status: 'completed',
          filePath: '/downloads/output.bin',
          saveDir: '/downloads',
          filename: 'output.bin',
          progress: 100,
          totalBytes: 1,
          downloadedBytes: 1,
          uploadedBytes: 0,
          sizeWhenDone: 1,
          fileCount: 1,
          createdAt: 1_000,
          updatedAt: 1_000,
          finishedAt: 1_000,
          category: null,
          infoHash: null,
          error: null,
        },
      },
    },
    candidates: [
      {
        hook: 'afterComplete',
        executable: {
          pluginId: 'plugin.example',
          version: '1.0.0',
          digest: 'a'.repeat(64),
        },
        createdGeneration: 1,
        requiredPermissions: [],
        createdEffectivePermissions: [],
      },
    ],
    createdAt: 1_000,
  })[0]
}
