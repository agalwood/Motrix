import { materializePostDeliveries } from '@core/plugin/post/delivery-materializer'
import { PostDeliveryQuotaConfigSchema } from '@core/plugin/post/delivery-types'
import { DownloadErrorCode } from '@shared/errors'
import type { AppNotification } from '@shared/types/notification'
import { NotificationKinds } from '@shared/types/notification'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import type {
  TaskDiagnosisOccurrence,
  TaskTerminalOccurrence,
} from '@shared/types/task-occurrence'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  MotrixDatabase,
  type NewNotificationInput,
  NOTIFICATION_DISPLAY_CAP,
  type TaskInstanceRow,
  type TaskRow,
} from './motrix-database'

describe('saveTaskWithInstances + getAllTasks (Plan A v1 schema)', () => {
  it('round-trips a single-instance task', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()

    const taskRow: TaskRow = makeTaskRow('m-1', TaskKind.Direct)
    taskRow.aggStatus = TaskStatus.Downloading
    taskRow.totalBytes = 1000
    taskRow.downloadedBytes = 500

    const instance: TaskInstanceRow = {
      ...makeInstanceRow('i-1', 'm-1', 'g-1', TaskInstancePhase.HttpDownload),
      status: TaskStatus.Downloading,
      progress: 50,
      totalBytes: 1000,
      downloadedBytes: 500,
      uris: ['https://example.com/video.mp4'],
      uriHash: 'urihash-1',
      diskPath: '/tmp/dl',
    }

    db.saveTaskWithInstances({ task: taskRow, instances: [instance] })

    const loaded = db.getAllTasks()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].task.motrixId).toBe('m-1')
    expect(loaded[0].task.kind).toBe(TaskKind.Direct)
    expect(loaded[0].task.aggStatus).toBe(TaskStatus.Downloading)
    expect(loaded[0].instances).toHaveLength(1)
    expect(loaded[0].instances[0].gid).toBe('g-1')
    expect(loaded[0].instances[0].phase).toBe(TaskInstancePhase.HttpDownload)
    expect(loaded[0].instances[0].uris).toEqual([
      'https://example.com/video.mp4',
    ])

    db.close()
  })

  it('commits an initial task and beforeCreate metadata atomically', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-create-metadata', TaskKind.Direct)

    db.persistTaskWithPluginMetadata({ task, instances: [] }, [
      {
        pluginId: 'plugin.example',
        op: 'set',
        key: 'source',
        value: { resolver: 'example' },
      },
    ])

    expect(db.getTask(task.motrixId)?.task).toMatchObject({
      motrixId: task.motrixId,
    })
    expect(
      db.database
        .prepare(
          `SELECT value FROM plugin_task_metadata
           WHERE task_id=? AND plugin_id=? AND key=?`
        )
        .get(task.motrixId, 'plugin.example', 'source')
    ).toEqual({ value: '{"resolver":"example"}' })
    db.close()
  })

  it('rolls the initial task back when beforeCreate metadata is rejected', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-create-metadata-rollback', TaskKind.Direct)

    expect(() =>
      db.persistTaskWithPluginMetadata({ task, instances: [] }, [
        {
          pluginId: 'plugin.example',
          op: 'set',
          key: 'oversized',
          value: 'x'.repeat(64 * 1024 + 1),
        },
      ])
    ).toThrow('staged plugin metadata exceeds per-task quota')

    expect(db.getTask(task.motrixId)).toBeNull()
    expect(
      db.database
        .prepare(`SELECT 1 FROM plugin_task_metadata WHERE task_id=?`)
        .get(task.motrixId)
    ).toBeUndefined()
    db.close()
  })

  it('round-trips a multi-instance task', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()

    const taskRow: TaskRow = makeTaskRow('m-hls', TaskKind.Hls)
    const seg0: TaskInstanceRow = {
      ...makeInstanceRow(
        'i-seg-0',
        'm-hls',
        'g-seg-0',
        TaskInstancePhase.HlsSegment
      ),
      payload: { segmentIndex: 0 },
    }
    const mux: TaskInstanceRow = {
      ...makeInstanceRow('i-mux', 'm-hls', null, TaskInstancePhase.FfmpegMux),
      payload: { ffmpegArgs: ['-c:v', 'copy'] },
    }

    db.saveTaskWithInstances({ task: taskRow, instances: [seg0, mux] })

    const loaded = db.getAllTasks()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].instances).toHaveLength(2)
    expect(loaded[0].instances.map((i) => i.phase).sort()).toEqual([
      TaskInstancePhase.FfmpegMux,
      TaskInstancePhase.HlsSegment,
    ])
    const muxLoaded = loaded[0].instances.find(
      (i) => i.phase === TaskInstancePhase.FfmpegMux
    )
    expect(muxLoaded?.gid).toBeNull()
    expect(muxLoaded?.payload).toEqual({ ffmpegArgs: ['-c:v', 'copy'] })

    db.close()
  })

  it('replaceInstances atomically swaps a task instance set', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const taskRow: TaskRow = makeTaskRow('m-swap', TaskKind.Bt)
    const oldInstance: TaskInstanceRow = makeInstanceRow(
      'i-old',
      'm-swap',
      'g-old',
      TaskInstancePhase.MagnetMetadataResolution
    )
    db.saveTaskWithInstances({ task: taskRow, instances: [oldInstance] })

    const newInstance: TaskInstanceRow = makeInstanceRow(
      'i-new',
      'm-swap',
      'g-new',
      TaskInstancePhase.BtDownload
    )
    db.replaceInstances('m-swap', [newInstance])

    const loaded = db.getAllTasks()
    expect(loaded[0].instances).toHaveLength(1)
    expect(loaded[0].instances[0].instanceId).toBe('i-new')
    expect(loaded[0].instances[0].phase).toBe(TaskInstancePhase.BtDownload)

    db.close()
  })

  it('deleteTask cascades to task_instances and task_files', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const taskRow: TaskRow = makeTaskRow('m-del', TaskKind.Direct)
    const instance: TaskInstanceRow = makeInstanceRow(
      'i-del',
      'm-del',
      'g-del',
      TaskInstancePhase.HttpDownload
    )
    db.saveTaskWithInstances({ task: taskRow, instances: [instance] })
    db.replaceTaskFiles('m-del', [
      { fileIndex: 0, path: '/a.bin', size: 100, selected: true },
    ])

    db.deleteTask('m-del')

    expect(db.getAllTasks()).toEqual([])
    expect(db.getTaskFiles('m-del')).toEqual([])

    db.close()
  })

  it('rebases persisted task files inside the terminal commit transaction', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-finalize-files', TaskKind.Direct)
    const sourcePath = '/downloads/file.bin.motrix'
    const targetPath = '/downloads/file.bin'
    db.saveTaskWithInstances({ task, instances: [] })
    db.replaceTaskFiles(task.motrixId, [
      {
        fileIndex: 7,
        path: sourcePath,
        size: 42,
        selected: false,
      },
    ])

    expect(() =>
      db.commitTerminalHookBoundary({
        payload: {
          task: {
            ...task,
            finalPath: targetPath,
            aggStatus: TaskStatus.Completed,
          },
          instances: [],
        },
        occurrence: null,
        fileRebase: { sourceRoot: sourcePath, targetRoot: targetPath },
      })
    ).not.toThrow()
    expect(db.getTaskFiles(task.motrixId)).toEqual([
      {
        fileIndex: 7,
        path: targetPath,
        size: 42,
        selected: false,
      },
    ])

    db.close()
  })

  it.each(Object.values(TaskType))(
    'round-trips canonical task type %s',
    (taskType) => {
      const db = new MotrixDatabase(':memory:')
      db.init()
      const task = {
        ...makeTaskRow(`m-${taskType}`, TaskKind.Direct),
        taskType,
      }

      db.saveTaskWithInstances({ task, instances: [] })

      expect(db.getTask(task.motrixId)?.task.taskType).toBe(taskType)
      db.close()
    }
  )

  it('round-trips null and populated terminal metadata', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const pending = makeTaskRow('m-pending', TaskKind.Direct)
    const failed = {
      ...makeTaskRow('m-failed', TaskKind.Direct),
      aggStatus: TaskStatus.Error,
      finishedAt: 1234,
      errorMessage: 'network failed',
      errorCode: DownloadErrorCode.NetworkError,
    }

    db.saveTasksBatch([
      { task: pending, instances: [] },
      { task: failed, instances: [] },
    ])

    expect(db.getTask('m-pending')?.task).toMatchObject({
      finishedAt: null,
      errorMessage: null,
      errorCode: null,
    })
    expect(db.getTask('m-failed')?.task).toMatchObject({
      finishedAt: 1234,
      errorMessage: 'network failed',
      errorCode: DownloadErrorCode.NetworkError,
    })
    db.close()
  })

  it('normalizes invalid persisted error codes to Unknown', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-invalid-error', TaskKind.Direct)
    db.saveTaskWithInstances({ task, instances: [] })
    db.database
      .prepare('UPDATE tasks SET error_code = ? WHERE motrix_id = ?')
      .run('not-a-domain-code', task.motrixId)

    expect(db.getTask(task.motrixId)?.task.errorCode).toBe(
      DownloadErrorCode.Unknown
    )
    db.close()
  })

  it('upserts failure fields without changing createdAt', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-upsert', TaskKind.Direct)
    db.saveTaskWithInstances({ task, instances: [] })

    db.saveTaskWithInstances({
      task: {
        ...task,
        createdAt: 9999,
        updatedAt: 2000,
        aggStatus: TaskStatus.Error,
        finishedAt: 2000,
        errorMessage: 'failed',
        errorCode: DownloadErrorCode.Unknown,
      },
      instances: [],
    })

    expect(db.getTask(task.motrixId)?.task).toMatchObject({
      createdAt: task.createdAt,
      updatedAt: 2000,
      finishedAt: 2000,
      errorMessage: 'failed',
      errorCode: DownloadErrorCode.Unknown,
    })
    db.close()
  })

  it('round-trips error detail fields and diagnosis revision', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = {
      ...makeTaskRow('m-detail', TaskKind.Direct),
      aggStatus: TaskStatus.Error,
      finishedAt: 1234,
      errorMessage: 'read failed',
      errorCode: DownloadErrorCode.FileWriteError,
      errorDetailKey: 'task.error.detail.filesMissing',
      errorDetailParams: { p: '1' },
      diagnosisRevision: 2,
    }

    db.saveTaskWithInstances({ task, instances: [] })

    expect(db.getTask('m-detail')?.task).toMatchObject({
      errorDetailKey: 'task.error.detail.filesMissing',
      errorDetailParams: { p: '1' },
      diagnosisRevision: 2,
    })
    db.close()
  })

  it('degrades malformed persisted error_detail_params JSON to null', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-malformed-detail', TaskKind.Direct)
    db.saveTaskWithInstances({ task, instances: [] })
    db.database
      .prepare('UPDATE tasks SET error_detail_params = ? WHERE motrix_id = ?')
      .run('not-json', task.motrixId)

    expect(db.getTask(task.motrixId)?.task.errorDetailParams).toBeNull()
    db.close()
  })
})

describe('saveTasksBatch unchanged-row skip', () => {
  it('skips rewriting a row whose content is unchanged, rewrites a changed one', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()

    const payload = {
      task: makeTaskRow('m-skip', TaskKind.Direct),
      instances: [
        makeInstanceRow(
          'i-skip',
          'm-skip',
          'g-skip',
          TaskInstancePhase.HttpDownload
        ),
      ],
    }
    db.saveTasksBatch([payload])

    // Tamper the persisted row directly, bypassing the manager. A skipped
    // save leaves the tamper intact; a real write overwrites it.
    db.database
      .prepare('UPDATE tasks SET name = ? WHERE motrix_id = ?')
      .run('TAMPERED', 'm-skip')

    // Same content ⇒ signature unchanged ⇒ write skipped ⇒ tamper survives.
    db.saveTasksBatch([payload])
    expect(db.getTask('m-skip')?.task.name).toBe('TAMPERED')

    // Changed content ⇒ signature differs ⇒ row rewritten ⇒ tamper gone.
    db.saveTasksBatch([
      { ...payload, task: { ...payload.task, name: 'CHANGED' } },
    ])
    expect(db.getTask('m-skip')?.task.name).toBe('CHANGED')

    db.close()
  })

  it('rewrites after deleteTask evicts the cached signature', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const payload = {
      task: makeTaskRow('m-evict', TaskKind.Direct),
      instances: [
        makeInstanceRow(
          'i-e',
          'm-evict',
          'g-e',
          TaskInstancePhase.HttpDownload
        ),
      ],
    }
    db.saveTasksBatch([payload])
    db.deleteTask('m-evict')

    // After deletion the signature is evicted, so re-saving identical content
    // must actually write (not skip) — otherwise the row would stay deleted.
    db.saveTasksBatch([payload])
    expect(db.getTask('m-evict')?.task.motrixId).toBe('m-evict')

    db.close()
  })
})

describe('deleteTasks', () => {
  it('atomically deletes multiple tasks and their instances/files', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const payloads = ['a', 'b'].map((id) => ({
      task: makeTaskRow(id, TaskKind.Direct),
      instances: [
        makeInstanceRow(
          `instance-${id}`,
          id,
          `gid-${id}`,
          TaskInstancePhase.HttpDownload
        ),
      ],
    }))
    db.saveTasksBatch(payloads)
    for (const id of ['a', 'b']) {
      db.replaceTaskFiles(id, [
        { fileIndex: 0, path: `/${id}`, size: 1, selected: true },
      ])
    }

    db.deleteTasks(['a', 'b'])

    expect(db.getAllTasks()).toEqual([])
    expect(db.getTaskFiles('a')).toEqual([])
    expect(db.getTaskFiles('b')).toEqual([])
    db.close()
  })

  it('deduplicates ids, accepts an empty list, and evicts signatures after commit', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const payload = {
      task: makeTaskRow('a', TaskKind.Direct),
      instances: [],
    }
    db.saveTasksBatch([payload])

    db.deleteTasks([])
    expect(db.getTask('a')).not.toBeNull()

    db.deleteTasks(['a', 'a'])
    expect(db.getTask('a')).toBeNull()

    // Successful commit evicts the old signature, so identical content is
    // written again instead of being skipped as already persisted.
    db.saveTasksBatch([payload])
    expect(db.getTask('a')?.task.name).toBe('a')
    db.close()
  })

  it('rolls back the batch and preserves signature cache when deletion fails', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const payloads = ['a', 'b'].map((id) => ({
      task: makeTaskRow(id, TaskKind.Direct),
      instances: [],
    }))
    db.saveTasksBatch(payloads)
    db.database.exec(`
      CREATE TRIGGER fail_second_task_delete
      BEFORE DELETE ON tasks
      WHEN OLD.motrix_id = 'b'
      BEGIN
        SELECT RAISE(ABORT, 'delete failed');
      END;
    `)

    expect(() => db.deleteTasks(['a', 'b'])).toThrow('delete failed')
    expect(
      db
        .getAllTasks()
        .map((row) => row.task.motrixId)
        .sort()
    ).toEqual(['a', 'b'])

    db.database.exec('DROP TRIGGER fail_second_task_delete')
    db.database
      .prepare('UPDATE tasks SET name = ? WHERE motrix_id = ?')
      .run('TAMPERED', 'a')
    db.saveTasksBatch(payloads)
    // A failed delete must not evict the signature. The identical payload is
    // therefore skipped and the direct tamper remains visible.
    expect(db.getTask('a')?.task.name).toBe('TAMPERED')
    db.close()
  })

  it('leaves Transfer tables unchanged', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    db.saveTaskWithInstances({
      task: makeTaskRow('a', TaskKind.Direct),
      instances: [],
    })
    db.database
      .prepare(
        `INSERT INTO transfer_totals (
          id, download_bytes, upload_bytes, tracking_started_at, updated_at
        ) VALUES (1, 10, 20, 1, 2)`
      )
      .run()
    db.database
      .prepare(
        `INSERT INTO transfer_buckets (
          bucket_start_ms, download_bytes, upload_bytes, updated_at
        ) VALUES (0, 3, 4, 5)`
      )
      .run()

    db.deleteTasks(['a'])

    expect(
      db.database
        .prepare(
          'SELECT download_bytes, upload_bytes FROM transfer_totals WHERE id = 1'
        )
        .get()
    ).toEqual({ download_bytes: 10, upload_bytes: 20 })
    expect(
      db.database
        .prepare(
          'SELECT download_bytes, upload_bytes FROM transfer_buckets WHERE bucket_start_ms = 0'
        )
        .get()
    ).toEqual({ download_bytes: 3, upload_bytes: 4 })
    db.close()
  })
})

describe('task occurrence outbox', () => {
  it('persistTaskWithOccurrence upserts the task and inserts the occurrence atomically', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-occ', TaskKind.Direct)
    const occ = makeTerminalOccurrence({ taskId: 'm-occ' })

    db.persistTaskWithOccurrence({ task, instances: [] }, occ)

    expect(db.getTask('m-occ')?.task.motrixId).toBe('m-occ')
    expect(db.listUndispatchedOccurrences()).toEqual([occ])
    db.close()
  })

  it('persists only the task when occurrence is null', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-occ-null', TaskKind.Direct)

    db.persistTaskWithOccurrence({ task, instances: [] }, null)

    expect(db.getTask('m-occ-null')?.task.motrixId).toBe('m-occ-null')
    expect(db.listUndispatchedOccurrences()).toEqual([])
    db.close()
  })

  it('duplicate occurrence_id via INSERT OR IGNORE is a silent no-op while the task row still updates', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const taskV1 = makeTaskRow('m-dup', TaskKind.Direct)
    const occ = makeTerminalOccurrence({
      occurrenceId: 'occ-dup',
      taskId: 'm-dup',
    })
    db.persistTaskWithOccurrence({ task: taskV1, instances: [] }, occ)

    const taskV2 = { ...taskV1, name: 'renamed' }
    const occAgain = makeTerminalOccurrence({
      occurrenceId: 'occ-dup',
      taskId: 'm-dup',
      cause: 'user-cancel',
    })
    expect(() =>
      db.persistTaskWithOccurrence({ task: taskV2, instances: [] }, occAgain)
    ).not.toThrow()

    expect(db.getTask('m-dup')?.task.name).toBe('renamed')
    // The first occurrence's content wins; the second insert was ignored.
    expect(db.listUndispatchedOccurrences()).toEqual([occ])
    db.close()
  })

  it('rolls back the whole transaction (task write included) when the occurrence insert fails', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const original = makeTaskRow('m-rollback', TaskKind.Direct)
    db.persistTaskWithOccurrence({ task: original, instances: [] }, null)
    db.database.exec(`
      CREATE TRIGGER fail_forced_occurrence_insert
      BEFORE INSERT ON task_occurrences
      WHEN NEW.occurrence_id = 'forced-fail'
      BEGIN
        SELECT RAISE(ABORT, 'forced failure');
      END;
    `)

    const changed = { ...original, name: 'should-not-persist' }
    const occ = makeTerminalOccurrence({
      occurrenceId: 'forced-fail',
      taskId: 'm-rollback',
    })

    expect(() =>
      db.persistTaskWithOccurrence({ task: changed, instances: [] }, occ)
    ).toThrow('forced failure')

    expect(db.getTask('m-rollback')?.task.name).toBe(original.name)
    expect(db.listUndispatchedOccurrences()).toEqual([])

    db.database.exec('DROP TRIGGER fail_forced_occurrence_insert')
    db.close()
  })

  it('listUndispatchedOccurrences returns rows in created_at ASC order', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-order', TaskKind.Direct)
    db.persistTaskWithOccurrence({ task, instances: [] }, null)
    const occLate = makeTerminalOccurrence({
      occurrenceId: 'occ-late',
      taskId: 'm-order',
      createdAt: 300,
    })
    const occEarly = makeTerminalOccurrence({
      occurrenceId: 'occ-early',
      taskId: 'm-order',
      createdAt: 100,
    })
    const occMid = makeTerminalOccurrence({
      occurrenceId: 'occ-mid',
      taskId: 'm-order',
      createdAt: 200,
    })
    db.persistTaskWithOccurrence({ task, instances: [] }, occLate)
    db.persistTaskWithOccurrence({ task, instances: [] }, occEarly)
    db.persistTaskWithOccurrence({ task, instances: [] }, occMid)

    expect(db.listUndispatchedOccurrences().map((o) => o.occurrenceId)).toEqual(
      ['occ-early', 'occ-mid', 'occ-late']
    )
    db.close()
  })

  it('markOccurrenceDispatched excludes the row from listUndispatchedOccurrences', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-mark', TaskKind.Direct)
    const occ = makeTerminalOccurrence({
      occurrenceId: 'occ-mark',
      taskId: 'm-mark',
    })
    db.persistTaskWithOccurrence({ task, instances: [] }, occ)

    db.markOccurrenceDispatched('occ-mark')

    expect(db.listUndispatchedOccurrences()).toEqual([])
    db.close()
  })

  it('deleteTask retires the task occurrence rows in the same transaction', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-del-with-occ', TaskKind.Direct)
    const occ = makeTerminalOccurrence({
      occurrenceId: 'occ-del-with-task',
      taskId: 'm-del-with-occ',
    })
    db.persistTaskWithOccurrence({ task, instances: [] }, occ)
    expect(db.listUndispatchedOccurrences()).toEqual([occ])

    db.deleteTask('m-del-with-occ')

    expect(db.getTask('m-del-with-occ')).toBeNull()
    expect(db.listUndispatchedOccurrences()).toEqual([])
    db.close()
  })

  it('deleteTaskOccurrences removes only rows for the given taskId', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const taskA = makeTaskRow('m-del-a', TaskKind.Direct)
    const taskB = makeTaskRow('m-del-b', TaskKind.Direct)
    const occA = makeTerminalOccurrence({
      occurrenceId: 'occ-a',
      taskId: 'm-del-a',
    })
    const occB = makeTerminalOccurrence({
      occurrenceId: 'occ-b',
      taskId: 'm-del-b',
    })
    db.persistTaskWithOccurrence({ task: taskA, instances: [] }, occA)
    db.persistTaskWithOccurrence({ task: taskB, instances: [] }, occB)

    db.deleteTaskOccurrences('m-del-a')

    expect(db.listUndispatchedOccurrences().map((o) => o.occurrenceId)).toEqual(
      ['occ-b']
    )
    db.close()
  })

  it('round-trips a diagnosis occurrence', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-diag', TaskKind.Direct)
    const occ = makeDiagnosisOccurrence({ taskId: 'm-diag' })

    db.persistTaskWithOccurrence({ task, instances: [] }, occ)

    expect(db.listUndispatchedOccurrences()).toEqual([occ])
    db.close()
  })

  it('skips a malformed payload row and returns the remaining valid rows', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-malformed-occ', TaskKind.Direct)
    const validOcc = makeTerminalOccurrence({
      occurrenceId: 'occ-valid',
      taskId: 'm-malformed-occ',
      createdAt: 100,
    })
    db.persistTaskWithOccurrence({ task, instances: [] }, validOcc)
    // Insert a corrupt row directly, bypassing persistTaskWithOccurrence,
    // to simulate payload drift/corruption the Zod schema must catch.
    db.database
      .prepare(
        `INSERT INTO task_occurrences (
          occurrence_id, type, task_id, from_status, to_status, cause,
          revision, payload, created_at, dispatched_at
        ) VALUES ('occ-corrupt', 'terminal', 'm-malformed-occ', NULL, NULL, NULL, NULL, ?, 200, NULL)`
      )
      .run('not-json')

    expect(db.listUndispatchedOccurrences().map((o) => o.occurrenceId)).toEqual(
      ['occ-valid']
    )
    db.close()
  })
})

describe('notification store', () => {
  it('insertNotificationWithLedger round-trips all fields', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const input = makeNotificationInput({
      sourceKey: 'src-roundtrip',
      taskId: 'm-1',
      kind: NotificationKinds.TaskComplete,
      severity: 'warning',
      titleKey: 'notif.title',
      titleParams: { name: 'file.zip' },
      bodyKey: 'notif.body',
      bodyParams: { size: '10MB' },
      createdAt: 1234,
    })

    const result = db.insertNotificationWithLedger(input)

    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      sourceKey: 'src-roundtrip',
      taskId: 'm-1',
      kind: NotificationKinds.TaskComplete,
      severity: 'warning',
      titleKey: 'notif.title',
      titleParams: { name: 'file.zip' },
      bodyKey: 'notif.body',
      bodyParams: { size: '10MB' },
      createdAt: 1234,
      readAt: null,
    })
    expect(typeof result?.id).toBe('string')
    expect(db.listNotifications()).toEqual([result])
    db.close()
  })

  it('duplicate sourceKey returns null on the second insert, leaving exactly one display row', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const first = db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'dup-key' })
    )
    const second = db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'dup-key', titleKey: 'other.title' })
    )

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(db.listNotifications()).toHaveLength(1)
    db.close()
  })

  it('re-inserting the same sourceKey after its display row was deleted still returns null (ledger survives the display delete)', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const first = db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'ledger-survives' })
    )
    expect(first).not.toBeNull()

    db.deleteNotification((first as AppNotification).id)
    expect(db.listNotifications()).toEqual([])

    const second = db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'ledger-survives' })
    )

    expect(second).toBeNull()
    expect(db.listNotifications()).toEqual([])
    db.close()
  })

  it('caps display rows at NOTIFICATION_DISPLAY_CAP, pruning the oldest first regardless of read state', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()

    const results: Array<AppNotification | null> = []
    for (let i = 0; i < NOTIFICATION_DISPLAY_CAP + 2; i++) {
      results.push(
        db.insertNotificationWithLedger(
          makeNotificationInput({ sourceKey: `cap-${i}`, createdAt: 1000 + i })
        )
      )
    }
    // Mark an early survivor read to prove read state doesn't protect a
    // row from the prune — only recency does.
    const survivor = results[2]
    if (survivor) db.markNotificationRead(survivor.id, 9999)

    const remaining = db.listNotifications(NOTIFICATION_DISPLAY_CAP + 10)
    expect(remaining).toHaveLength(NOTIFICATION_DISPLAY_CAP)
    const remainingSourceKeys = new Set(remaining.map((n) => n.sourceKey))
    expect(remainingSourceKeys.has('cap-0')).toBe(false)
    expect(remainingSourceKeys.has('cap-1')).toBe(false)
    expect(remainingSourceKeys.has('cap-2')).toBe(true)
    db.close()
  })

  it('reads back malformed title_params JSON on disk as null', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    db.database
      .prepare(
        `INSERT INTO notifications (
          id, source_key, kind, severity, title_key, title_params,
          body_key, body_params, task_id, created_at, read_at
        ) VALUES ('corrupt-1', 'src-corrupt', 'task-complete', 'info',
          'notif.title', 'not-json', NULL, NULL, NULL, 1000, NULL)`
      )
      .run()

    const [listed] = db.listNotifications()
    expect(listed.titleParams).toBeNull()
    expect(listed.titleKey).toBe('notif.title')
    db.close()
  })

  it('getUnreadNotificationCount counts only rows with a null read_at', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const a = db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'unread-a' })
    )
    db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'unread-b' })
    )
    expect(db.getUnreadNotificationCount()).toBe(2)

    db.markNotificationRead((a as AppNotification).id, 2000)
    expect(db.getUnreadNotificationCount()).toBe(1)
    db.close()
  })

  it('markNotificationRead returns true for an existing row and false for an unknown id', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const notif = db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'mark-read' })
    )

    expect(db.markNotificationRead((notif as AppNotification).id, 3000)).toBe(
      true
    )
    expect(db.markNotificationRead('missing-id', 3000)).toBe(false)
    expect(db.listNotifications()[0].readAt).toBe(3000)
    db.close()
  })

  it('markAllNotificationsRead marks every unread row and returns the affected count', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'all-a' })
    )
    db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'all-b' })
    )

    const count = db.markAllNotificationsRead(4000)

    expect(count).toBe(2)
    expect(db.getUnreadNotificationCount()).toBe(0)
    db.close()
  })

  it('deleteNotification removes the display row and returns true, false for an unknown id', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const notif = db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'del-1' })
    )

    expect(db.deleteNotification((notif as AppNotification).id)).toBe(true)
    expect(db.listNotifications()).toEqual([])
    expect(db.deleteNotification('unknown')).toBe(false)
    db.close()
  })

  it('clearNotifications deletes all display rows but leaves the ledger untouched', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'clear-a' })
    )
    db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'clear-b' })
    )

    const count = db.clearNotifications()

    expect(count).toBe(2)
    expect(db.listNotifications()).toEqual([])
    // The ledger rows survive the display-side clear: re-inserting the
    // same sourceKey is still recognized as a duplicate.
    expect(
      db.insertNotificationWithLedger(
        makeNotificationInput({ sourceKey: 'clear-a' })
      )
    ).toBeNull()
    db.close()
  })

  it("deleteTask removes that task's notification ledger rows", () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = makeTaskRow('m-notif-del', TaskKind.Direct)
    db.saveTaskWithInstances({ task, instances: [] })
    db.insertNotificationWithLedger(
      makeNotificationInput({
        sourceKey: 'task-del-src',
        taskId: 'm-notif-del',
      })
    )

    db.deleteTask('m-notif-del')

    expect(
      db.database
        .prepare(
          'SELECT COUNT(*) AS c FROM notification_occurrences WHERE task_id = ?'
        )
        .get('m-notif-del')
    ).toEqual({ c: 0 })
    db.close()
  })

  it('deleteTasks removes the notification ledger rows for every deleted task', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const taskA = makeTaskRow('m-notif-del-a', TaskKind.Direct)
    const taskB = makeTaskRow('m-notif-del-b', TaskKind.Direct)
    db.saveTaskWithInstances({ task: taskA, instances: [] })
    db.saveTaskWithInstances({ task: taskB, instances: [] })
    db.insertNotificationWithLedger(
      makeNotificationInput({
        sourceKey: 'batch-del-a',
        taskId: 'm-notif-del-a',
      })
    )
    db.insertNotificationWithLedger(
      makeNotificationInput({
        sourceKey: 'batch-del-b',
        taskId: 'm-notif-del-b',
      })
    )

    db.deleteTasks(['m-notif-del-a', 'm-notif-del-b'])

    expect(
      db.database
        .prepare('SELECT COUNT(*) AS c FROM notification_occurrences')
        .get()
    ).toEqual({ c: 0 })
    db.close()
  })

  it('updateNotificationBySourceKey patches the body fields and returns false for an unknown sourceKey', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    db.insertNotificationWithLedger(
      makeNotificationInput({
        sourceKey: 'update-src',
        bodyKey: 'old.body',
        bodyParams: { a: '1' },
      })
    )

    const updated = db.updateNotificationBySourceKey('update-src', {
      bodyKey: 'new.body',
      bodyParams: { b: '2' },
    })
    expect(updated).toBe(true)
    const [listed] = db.listNotifications()
    expect(listed.bodyKey).toBe('new.body')
    expect(listed.bodyParams).toEqual({ b: '2' })

    expect(
      db.updateNotificationBySourceKey('missing-src', {
        bodyKey: null,
        bodyParams: null,
      })
    ).toBe(false)
    db.close()
  })

  it('deleteEngineNotificationLedgerBefore removes only task_id IS NULL rows older than the cutoff', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const engineOld = db.insertNotificationWithLedger(
      makeNotificationInput({
        sourceKey: 'engine-old',
        taskId: null,
        createdAt: 1000,
      })
    )
    db.insertNotificationWithLedger(
      makeNotificationInput({
        sourceKey: 'engine-new',
        taskId: null,
        createdAt: 5000,
      })
    )
    db.insertNotificationWithLedger(
      makeNotificationInput({
        sourceKey: 'task-bound-old',
        taskId: 'm-1',
        createdAt: 1000,
      })
    )

    const removed = db.deleteEngineNotificationLedgerBefore(2000)

    expect(removed).toBe(1)
    // The pruned row frees the LEDGER's claim on this sourceKey, but F3's
    // partial UNIQUE index on `notifications.source_key` still blocks a
    // byte-identical reuse while the stale DISPLAY row survives (this
    // method only ever touches the ledger — see its own docstring). Drop
    // that display row too (its own aging/clear/prune path in real use) to
    // exercise the reuse the ledger cleanup is meant to enable.
    db.deleteNotification((engineOld as AppNotification).id)
    expect(
      db.insertNotificationWithLedger(
        makeNotificationInput({
          sourceKey: 'engine-old',
          taskId: null,
          createdAt: 6000,
        })
      )
    ).not.toBeNull()
    // The newer engine row and the task-bound row are untouched.
    expect(
      db.insertNotificationWithLedger(
        makeNotificationInput({
          sourceKey: 'engine-new',
          taskId: null,
          createdAt: 6000,
        })
      )
    ).toBeNull()
    expect(
      db.insertNotificationWithLedger(
        makeNotificationInput({
          sourceKey: 'task-bound-old',
          taskId: 'm-1',
          createdAt: 6000,
        })
      )
    ).toBeNull()
    db.close()
  })

  it('rolls back the whole transaction when the display insert fails, leaving the source_key unburned for a retry', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    db.database.exec(`
      CREATE TRIGGER fail_forced_notification_insert
      BEFORE INSERT ON notifications
      WHEN NEW.title_key = 'forced-fail'
      BEGIN
        SELECT RAISE(ABORT, 'forced failure');
      END;
    `)

    expect(() =>
      db.insertNotificationWithLedger(
        makeNotificationInput({
          sourceKey: 'src-rollback',
          titleKey: 'forced-fail',
        })
      )
    ).toThrow('forced failure')

    expect(
      db.database
        .prepare(
          'SELECT COUNT(*) AS c FROM notification_occurrences WHERE source_key = ?'
        )
        .get('src-rollback')
    ).toEqual({ c: 0 })
    expect(db.listNotifications()).toEqual([])

    db.database.exec('DROP TRIGGER fail_forced_notification_insert')

    const retryResult = db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'src-rollback' })
    )
    expect(retryResult).not.toBeNull()
    db.close()
  })

  it('F3: a display-only UNIQUE(source_key) collision with no ledger row is dropped as stale — null, no duplicate, ledger rolled back', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()

    // Simulate the race the partial UNIQUE index backstops: a display row
    // for this sourceKey already exists (e.g. a future real-I/O consumer
    // interleaving) but the ledger never recorded it.
    db.database
      .prepare(
        `INSERT INTO notifications (
          id, source_key, kind, severity, title_key, title_params,
          body_key, body_params, task_id, created_at, read_at
        ) VALUES ('manual-race-row', 'race-key', 'task-complete', 'info',
          'notif.title', NULL, NULL, NULL, NULL, 1000, NULL)`
      )
      .run()

    const result = db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'race-key' })
    )

    expect(result).toBeNull()
    expect(db.listNotifications()).toHaveLength(1)
    expect(
      db.database
        .prepare(
          'SELECT COUNT(*) AS c FROM notification_occurrences WHERE source_key = ?'
        )
        .get('race-key')
    ).toEqual({ c: 0 })

    db.close()
  })

  it('narrows the UNIQUE stale-classification to source_key: an unrelated UNIQUE violation propagates instead of being swallowed as stale', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()

    // A UNIQUE index unrelated to F3's source_key backstop, added after
    // init() so it doesn't disturb canonical-schema validation. It proves
    // the catch in insertNotificationWithLedger only classifies
    // source_key collisions as stale — any other UNIQUE violation must
    // still surface as a genuine error.
    db.database.exec(
      'CREATE UNIQUE INDEX tmp_test_unique ON notifications(task_id)'
    )

    try {
      db.insertNotificationWithLedger(
        makeNotificationInput({ sourceKey: 'src-a', taskId: 't1' })
      )

      let caught: unknown
      try {
        db.insertNotificationWithLedger(
          makeNotificationInput({ sourceKey: 'src-b', taskId: 't1' })
        )
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(Database.SqliteError)
      expect((caught as InstanceType<typeof Database.SqliteError>).code).toBe(
        'SQLITE_CONSTRAINT_UNIQUE'
      )
    } finally {
      db.database.exec('DROP INDEX tmp_test_unique')
    }

    db.close()
  })

  it('F6: a clock-rollback insert beyond the cap window is dropped as stale — null, source_key not burned, retry with a sane timestamp succeeds', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()

    for (let i = 0; i < NOTIFICATION_DISPLAY_CAP; i++) {
      db.insertNotificationWithLedger(
        makeNotificationInput({
          sourceKey: `future-${i}`,
          createdAt: 1_000_000 + i,
        })
      )
    }

    const result = db.insertNotificationWithLedger(
      makeNotificationInput({
        sourceKey: 'rollback-key',
        createdAt: 1_000_000 - 5000,
      })
    )

    expect(result).toBeNull()
    expect(
      db.database
        .prepare(
          'SELECT COUNT(*) AS c FROM notification_occurrences WHERE source_key = ?'
        )
        .get('rollback-key')
    ).toEqual({ c: 0 })
    expect(db.listNotifications(NOTIFICATION_DISPLAY_CAP + 10)).toHaveLength(
      NOTIFICATION_DISPLAY_CAP
    )

    const retry = db.insertNotificationWithLedger(
      makeNotificationInput({ sourceKey: 'rollback-key', createdAt: 2_000_000 })
    )
    expect(retry).not.toBeNull()
    expect(db.listNotifications(NOTIFICATION_DISPLAY_CAP + 10)).toHaveLength(
      NOTIFICATION_DISPLAY_CAP
    )

    db.close()
  })
})

describe('terminal plugin Hook commit boundary', () => {
  it('commits task graph, files, metadata, finalize journal, occurrence, and delivery together', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = {
      ...makeTaskRow('m-hook-terminal', TaskKind.Direct),
      aggStatus: TaskStatus.Completed,
      finalPath: '/downloads/result.bin',
      finalName: 'result.bin',
      finishedAt: 2_000,
      updatedAt: 2_000,
    }
    insertTargetInstalledJournal(db, 'plan-terminal', task.motrixId)
    const occurrence = makeTerminalOccurrence({
      occurrenceId: 'occ-hook-terminal',
      taskId: task.motrixId,
      toStatus: TaskStatus.Completed,
      createdAt: 2_000,
    })
    const delivery = makePostAdmission(
      occurrence.occurrenceId,
      task.motrixId,
      2_000
    )

    const summary = db.commitTerminalHookBoundary({
      payload: { task, instances: [] },
      files: [
        {
          fileIndex: 0,
          path: task.finalPath,
          size: 7,
          selected: true,
        },
      ],
      occurrence,
      metadataOps: [
        {
          pluginId: 'plugin.example',
          op: 'set',
          key: 'checksum',
          value: 'abc123',
        },
      ],
      finalizeJournal: {
        journalId: 'plan-terminal',
        taskId: task.motrixId,
        targetIdentity: { kind: 'file', digest: 'abc123' },
        updatedAt: 2_000,
      },
      postDeliveries: [delivery],
    })

    expect(summary).toMatchObject({ admitted: 1, duplicates: 0, rejected: 0 })
    expect(db.getTask(task.motrixId)?.task).toMatchObject({
      aggStatus: TaskStatus.Completed,
      finalPath: task.finalPath,
    })
    expect(db.getTaskFiles(task.motrixId)).toEqual([
      { fileIndex: 0, path: task.finalPath, size: 7, selected: true },
    ])
    expect(
      db.database
        .prepare(
          `SELECT value FROM plugin_task_metadata
           WHERE task_id=? AND plugin_id='plugin.example' AND key='checksum'`
        )
        .get(task.motrixId)
    ).toEqual({ value: '"abc123"' })
    expect(db.listUndispatchedOccurrences()).toEqual([occurrence])
    expect(
      db.database
        .prepare(
          `SELECT phase, plan_json FROM plugin_finalize_journals
           WHERE plan_id='plan-terminal'`
        )
        .get()
    ).toEqual({
      phase: 'db_committed',
      plan_json: expect.stringContaining('"phase":"db_committed"'),
    })
    expect(
      db.database
        .prepare(
          `SELECT status, task_id FROM plugin_post_deliveries
           WHERE delivery_id=?`
        )
        .get(delivery.deliveryId)
    ).toEqual({ status: 'pending', task_id: task.motrixId })
    db.close()
  })

  it('does not count quota rejection twice when a terminal occurrence is replayed', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = {
      ...makeTaskRow('m-hook-replay', TaskKind.Direct),
      aggStatus: TaskStatus.Completed,
      finishedAt: 2_000,
      updatedAt: 2_000,
    }
    const occurrence = makeTerminalOccurrence({
      occurrenceId: 'occ-hook-replay',
      taskId: task.motrixId,
      toStatus: TaskStatus.Completed,
      createdAt: 2_000,
    })
    const first = makePostAdmission(
      occurrence.occurrenceId,
      task.motrixId,
      2_000
    )
    const rejected = {
      ...first,
      deliveryId: `${first.deliveryId}:second`,
      deduplicationKey: `${first.deduplicationKey}:second`,
    }
    const input = {
      payload: { task, instances: [] },
      occurrence,
      postDeliveries: [first, rejected],
      postQuota: PostDeliveryQuotaConfigSchema.parse({
        pluginActiveRows: 1,
      }),
    }

    expect(db.commitTerminalHookBoundary(input)).toMatchObject({
      admitted: 1,
      duplicates: 0,
      rejected: 1,
    })
    expect(db.commitTerminalHookBoundary(input)).toMatchObject({
      admitted: 0,
      duplicates: 2,
      rejected: 0,
    })
    expect(
      db.database
        .prepare(
          `SELECT rejected_count FROM plugin_post_quota_buckets
           WHERE plugin_id='plugin.example'`
        )
        .get()
    ).toEqual({ rejected_count: 1 })
    db.close()
  })

  it('rolls every terminal participant back when delivery persistence fails', () => {
    const db = new MotrixDatabase(':memory:')
    db.init()
    const task = {
      ...makeTaskRow('m-hook-rollback', TaskKind.Direct),
      aggStatus: TaskStatus.Completed,
      finalPath: '/downloads/rollback.bin',
      finalName: 'rollback.bin',
      finishedAt: 3_000,
      updatedAt: 3_000,
    }
    insertTargetInstalledJournal(db, 'plan-rollback', task.motrixId)
    const occurrence = makeTerminalOccurrence({
      occurrenceId: 'occ-hook-rollback',
      taskId: task.motrixId,
      toStatus: TaskStatus.Completed,
      createdAt: 3_000,
    })
    const delivery = makePostAdmission(
      occurrence.occurrenceId,
      task.motrixId,
      3_000
    )
    db.database.exec(`
      CREATE TRIGGER fail_post_delivery
      BEFORE INSERT ON plugin_post_deliveries
      BEGIN SELECT RAISE(ABORT, 'forced delivery failure'); END
    `)

    expect(() =>
      db.commitTerminalHookBoundary({
        payload: { task, instances: [] },
        occurrence,
        metadataOps: [
          {
            pluginId: 'plugin.example',
            op: 'set',
            key: 'must-rollback',
            value: true,
          },
        ],
        finalizeJournal: {
          journalId: 'plan-rollback',
          taskId: task.motrixId,
          targetIdentity: { kind: 'file', digest: 'rollback' },
          updatedAt: 3_000,
        },
        postDeliveries: [delivery],
      })
    ).toThrow('forced delivery failure')

    expect(db.getTask(task.motrixId)).toBeNull()
    expect(
      db.database
        .prepare(`SELECT 1 FROM plugin_task_metadata WHERE task_id=?`)
        .get(task.motrixId)
    ).toBeUndefined()
    expect(db.listUndispatchedOccurrences()).toEqual([])
    expect(
      db.database
        .prepare(
          `SELECT phase FROM plugin_finalize_journals WHERE plan_id='plan-rollback'`
        )
        .get()
    ).toEqual({ phase: 'target_installed' })
    db.close()
  })
})

function makeNotificationInput(
  overrides: Partial<NewNotificationInput> = {}
): NewNotificationInput {
  return {
    sourceKey: 'src-1',
    taskId: null,
    kind: NotificationKinds.TaskComplete,
    severity: 'info',
    titleKey: 'notification.title',
    titleParams: null,
    bodyKey: null,
    bodyParams: null,
    createdAt: 1700000000,
    ...overrides,
  }
}

function makeTerminalOccurrence(
  overrides: Partial<TaskTerminalOccurrence> = {}
): TaskTerminalOccurrence {
  return {
    occurrenceId: 'occ-1',
    type: 'terminal',
    taskId: 'm-1',
    fromStatus: TaskStatus.Downloading,
    toStatus: TaskStatus.Error,
    cause: 'engine',
    errorGroup: null,
    createdAt: 1000,
    ...overrides,
  }
}

function insertTargetInstalledJournal(
  db: MotrixDatabase,
  planId: string,
  taskId: string
): void {
  db.database
    .prepare(
      `INSERT INTO plugin_finalize_journals (
        plan_id, task_id, phase, plan_json, source_identity_json,
        target_identity_json, quarantine_reason, created_at, updated_at
      ) VALUES (?, ?, 'target_installed', ?, '{}', '{}', NULL, 1, 1)`
    )
    .run(
      planId,
      taskId,
      JSON.stringify({
        journalId: planId,
        phase: 'target_installed',
        plan: { planId, taskId },
      })
    )
}

function makePostAdmission(occurrenceId: string, taskId: string, at: number) {
  return materializePostDeliveries({
    event: {
      schemaVersion: 1,
      occurrenceId,
      taskId,
      occurredAt: at,
      payload: {
        filePath: '/downloads/result.bin',
        task: {
          schemaVersion: 1,
          id: taskId,
          name: 'result.bin',
          type: 'http',
          kind: 'direct',
          status: 'completed',
          filePath: '/downloads/result.bin',
          saveDir: '/downloads',
          filename: 'result.bin',
          progress: 100,
          totalBytes: 7,
          downloadedBytes: 7,
          uploadedBytes: 0,
          sizeWhenDone: 7,
          fileCount: 1,
          createdAt: at,
          updatedAt: at,
          finishedAt: at,
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
    createdAt: at,
  })[0]
}

function makeDiagnosisOccurrence(
  overrides: Partial<TaskDiagnosisOccurrence> = {}
): TaskDiagnosisOccurrence {
  return {
    occurrenceId: 'diag-1',
    type: 'diagnosis',
    taskId: 'm-1',
    terminalOccurrenceId: 'occ-1',
    revision: 1,
    diagnosis: {
      errorCode: DownloadErrorCode.DiskFull,
      errorMessage: 'disk full',
      errorDetailKey: null,
      errorDetailParams: null,
    },
    createdAt: 1000,
    ...overrides,
  }
}

function makeTaskRow(motrixId: string, kind: TaskKind): TaskRow {
  return {
    motrixId,
    name: motrixId,
    kind,
    taskType: kind === TaskKind.Bt ? TaskType.Bt : TaskType.Http,
    category: null,
    priority: 0,
    tags: null,
    createdAt: 1700000000,
    updatedAt: 1700000001,
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
    aggStatus: TaskStatus.Queued,
    finishedAt: null,
    errorMessage: null,
    errorCode: null,
    errorDetailKey: null,
    errorDetailParams: null,
    diagnosisRevision: 0,
    uploadedBytesBaseline: 0,
    source: 'user',
    sourceMeta: null,
  }
}

function makeInstanceRow(
  instanceId: string,
  motrixId: string,
  gid: string | null,
  phase: TaskInstancePhase
): TaskInstanceRow {
  return {
    instanceId,
    motrixId,
    gid,
    phase,
    status: TaskStatus.Queued,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath: '',
    transitionPhase: TransitionPhase.Idle,
    uris: [],
    uriHash: null,
    payload: {},
    createdAt: 1700000000,
    updatedAt: 1700000001,
  }
}
