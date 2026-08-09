import { MotrixDatabase, type TaskRow } from '@core/session/motrix-database'
import { DownloadErrorCode } from '@shared/errors'
import {
  type DownloadTask,
  TaskKind,
  TaskStatus,
  TaskType,
} from '@shared/types/task'
import {
  diagnosisOccurrenceId,
  terminalOccurrenceId,
} from '@shared/types/task-occurrence'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { applyDiagnosisUpgrade, type DiagnosisPatch } from './diagnosis-upgrade'
import { OccurrenceDispatcher } from './occurrences/occurrence-dispatcher'

function makeTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    motrixId: 'm-1',
    name: 'task',
    kind: TaskKind.Direct,
    taskType: TaskType.Http,
    category: null,
    priority: 0,
    tags: null,
    createdAt: 1000,
    updatedAt: 1000,
    finalPath: '',
    finalName: '',
    torrentMetaPath: null,
    infoHash: null,
    totalBytes: 0,
    downloadedBytes: 0,
    sizeWhenDone: 0,
    fileCount: 0,
    isPrivate: false,
    trackers: [],
    pieceLength: 0,
    aggStatus: TaskStatus.Error,
    finishedAt: 1000,
    errorMessage: null,
    errorCode: null,
    errorDetailKey: null,
    errorDetailParams: null,
    diagnosisRevision: 0,
    uploadedBytesBaseline: 0,
    source: 'user',
    sourceMeta: null,
    ...overrides,
  }
}

/** A dispatcher wired to a real MotrixDatabase's occurrence outbox, plus a
 *  spy consumer so tests can assert exactly how many diagnosis occurrences
 *  were actually dispatched. */
function makeDispatcher(db: MotrixDatabase, consumer = vi.fn()) {
  const dispatcher = new OccurrenceDispatcher({
    listUndispatched: () => db.listUndispatchedOccurrences(),
    markDispatched: (id) => db.markOccurrenceDispatched(id),
    log: { error: vi.fn(), warn: vi.fn() },
  })
  dispatcher.register('spy', consumer)
  return { dispatcher, consumer }
}

/** Seed a task row and return a matching DownloadTask domain object built
 *  from the same fields, so `current` (as read from `task`) starts in sync
 *  with what's actually in the DB. */
function seed(
  db: MotrixDatabase,
  overrides: Partial<TaskRow> = {}
): { row: TaskRow } {
  const row = makeTaskRow(overrides)
  db.saveTaskWithInstances({ task: row, instances: [] })
  return { row }
}

function taskFromRow(
  row: TaskRow,
  overrides: Partial<DownloadTask> = {}
): DownloadTask {
  return makeDownloadTask({
    id: row.motrixId,
    status: row.aggStatus,
    finishedAt: row.finishedAt,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    errorDetailKey: row.errorDetailKey,
    errorDetailParams: row.errorDetailParams,
    diagnosisRevision: row.diagnosisRevision,
    ...overrides,
  })
}

describe('applyDiagnosisUpgrade', () => {
  it('rejects a non-terminal task without touching the database', async () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const spy = vi.spyOn(db, 'applyDiagnosisUpgradeRow')
    const { dispatcher, consumer } = makeDispatcher(db)
    const task = makeDownloadTask({
      id: 'm-active',
      status: TaskStatus.Downloading,
    })

    const result = await applyDiagnosisUpgrade(
      { db, dispatcher },
      task,
      { errorMessage: 'too early' },
      0
    )

    expect(result).toEqual({ ok: false, reason: 'not-terminal' })
    expect(spy).not.toHaveBeenCalled()
    expect(consumer).not.toHaveBeenCalled()
    db.close()
  })

  it('returns revision-conflict and leaves the row untouched on a stale expectedRevision', async () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const { row } = seed(db, {
      motrixId: 'm-conflict',
      diagnosisRevision: 5,
      errorCode: DownloadErrorCode.DiskFull,
      errorMessage: 'old msg',
    })
    const { dispatcher, consumer } = makeDispatcher(db)
    const task = taskFromRow(row, { diagnosisRevision: 3 })

    const result = await applyDiagnosisUpgrade(
      { db, dispatcher },
      task,
      { errorMessage: 'new msg' },
      3
    )

    expect(result).toEqual({ ok: false, reason: 'revision-conflict' })
    const persisted = db.getTask('m-conflict')?.task
    expect(persisted?.errorMessage).toBe('old msg')
    expect(persisted?.diagnosisRevision).toBe(5)
    expect(db.listUndispatchedOccurrences()).toEqual([])
    expect(consumer).not.toHaveBeenCalled()
    db.close()
  })

  it('a stale snapshot whose group matches the patch gets revision-conflict, not a false no-op', async () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    // Another writer already advanced the row to revision 4 with a
    // different diagnosis.
    const { row } = seed(db, {
      motrixId: 'm-stale-noop',
      diagnosisRevision: 4,
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: 'network unreachable',
    })
    const { dispatcher, consumer } = makeDispatcher(db)
    // The caller still holds the pre-upgrade snapshot, and its patch would
    // be a no-op *against that snapshot*. Judged against the row it is not.
    const task = taskFromRow(row, {
      diagnosisRevision: 0,
      errorCode: DownloadErrorCode.DiskFull,
      errorMessage: 'disk full',
    })

    const result = await applyDiagnosisUpgrade(
      { db, dispatcher },
      task,
      { errorCode: DownloadErrorCode.DiskFull, errorMessage: 'disk full' },
      0
    )

    expect(result).toEqual({ ok: false, reason: 'revision-conflict' })
    const persisted = db.getTask('m-stale-noop')?.task
    expect(persisted?.errorMessage).toBe('network unreachable')
    expect(persisted?.diagnosisRevision).toBe(4)
    expect(consumer).not.toHaveBeenCalled()
    db.close()
  })

  it('a no-op is decided against the stored row, not the caller snapshot', async () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const { row } = seed(db, {
      motrixId: 'm-row-noop',
      diagnosisRevision: 2,
      errorCode: DownloadErrorCode.DiskFull,
      errorMessage: 'disk full',
    })
    const { dispatcher, consumer } = makeDispatcher(db)
    const task = taskFromRow(row)

    const result = await applyDiagnosisUpgrade(
      { db, dispatcher },
      task,
      { errorCode: DownloadErrorCode.DiskFull, errorMessage: 'disk full' },
      2
    )

    expect(result).toEqual({ ok: true, revision: 2, occurrence: null })
    expect(db.getTask('m-row-noop')?.task.diagnosisRevision).toBe(2)
    expect(db.listUndispatchedOccurrences()).toEqual([])
    expect(consumer).not.toHaveBeenCalled()
    db.close()
  })

  it('retrying the same patch after success is a no-op with no second occurrence', async () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const { row } = seed(db, { motrixId: 'm-retry', diagnosisRevision: 0 })
    const { dispatcher, consumer } = makeDispatcher(db)
    const task = taskFromRow(row)
    const patch: DiagnosisPatch = {
      errorCode: DownloadErrorCode.DiskFull,
      errorMessage: 'disk full',
    }

    const first = await applyDiagnosisUpgrade(
      { db, dispatcher },
      task,
      patch,
      0
    )
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('unreachable')
    expect(first.revision).toBe(1)
    expect(first.occurrence).not.toBeNull()
    expect(consumer).toHaveBeenCalledTimes(1)
    expect(task.diagnosisRevision).toBe(1)
    expect(task.errorCode).toBe(DownloadErrorCode.DiskFull)
    expect(task.errorMessage).toBe('disk full')

    const second = await applyDiagnosisUpgrade(
      { db, dispatcher },
      task,
      patch,
      1
    )

    expect(second).toEqual({ ok: true, revision: 1, occurrence: null })
    expect(consumer).toHaveBeenCalledTimes(1)
    const persisted = db.getTask('m-retry')?.task
    expect(persisted?.diagnosisRevision).toBe(1)
    expect(persisted?.errorMessage).toBe('disk full')
    db.close()
  })

  it('writes errorDetailParams as null when a key is patched without params', async () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const { row } = seed(db, {
      motrixId: 'm-pair',
      diagnosisRevision: 0,
      errorDetailKey: 'task.error.detail.oldKey',
      errorDetailParams: { foo: 'bar' },
    })
    const { dispatcher } = makeDispatcher(db)
    const task = taskFromRow(row)

    const result = await applyDiagnosisUpgrade(
      { db, dispatcher },
      task,
      { errorDetailKey: 'task.error.detail.newKey' },
      0
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.occurrence?.diagnosis.errorDetailKey).toBe(
      'task.error.detail.newKey'
    )
    expect(result.occurrence?.diagnosis.errorDetailParams).toBeNull()
    expect(task.errorDetailKey).toBe('task.error.detail.newKey')
    expect(task.errorDetailParams).toBeNull()

    const persisted = db.getTask('m-pair')?.task
    expect(persisted?.errorDetailKey).toBe('task.error.detail.newKey')
    expect(persisted?.errorDetailParams).toBeNull()
    db.close()
  })

  it('builds an occurrence with the correct terminalOccurrenceId and full diagnosis snapshot', async () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const { row } = seed(db, {
      motrixId: 'm-snap',
      diagnosisRevision: 7,
      aggStatus: TaskStatus.Error,
      finishedAt: 42000,
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: 'net down',
    })
    const { dispatcher, consumer } = makeDispatcher(db)
    const task = taskFromRow(row)

    const result = await applyDiagnosisUpgrade(
      { db, dispatcher },
      task,
      {
        errorDetailKey: 'task.error.detail.dns',
        errorDetailParams: { host: 'example.com' },
      },
      7
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.revision).toBe(8)
    const occ = result.occurrence
    expect(occ).not.toBeNull()
    if (!occ) throw new Error('unreachable')
    expect(occ.occurrenceId).toBe(diagnosisOccurrenceId('m-snap', 42000, 8))
    expect(occ.type).toBe('diagnosis')
    expect(occ.taskId).toBe('m-snap')
    expect(occ.terminalOccurrenceId).toBe(
      terminalOccurrenceId('m-snap', TaskStatus.Error, 42000)
    )
    expect(occ.revision).toBe(8)
    expect(occ.diagnosis).toEqual({
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: 'net down',
      errorDetailKey: 'task.error.detail.dns',
      errorDetailParams: { host: 'example.com' },
    })
    expect(consumer).toHaveBeenCalledWith(occ)
    db.close()
  })

  it('a second racing upgrade with the same stale expectedRevision gets revision-conflict', async () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const { row } = seed(db, { motrixId: 'm-race', diagnosisRevision: 2 })
    const { dispatcher, consumer } = makeDispatcher(db)
    const taskA = taskFromRow(row)
    const taskB = taskFromRow(row)

    const resultA = await applyDiagnosisUpgrade(
      { db, dispatcher },
      taskA,
      { errorMessage: 'A observed failure' },
      2
    )
    expect(resultA.ok).toBe(true)

    const resultB = await applyDiagnosisUpgrade(
      { db, dispatcher },
      taskB,
      { errorMessage: 'B observed different failure' },
      2
    )

    expect(resultB).toEqual({ ok: false, reason: 'revision-conflict' })
    const persisted = db.getTask('m-race')?.task
    expect(persisted?.errorMessage).toBe('A observed failure')
    expect(persisted?.diagnosisRevision).toBe(3)
    expect(consumer).toHaveBeenCalledTimes(1)
    db.close()
  })
})
