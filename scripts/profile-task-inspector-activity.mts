import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { arch, cpus, platform, release, tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { TaskStatus } from '@shared/types/task'
import {
  type TaskActivityCheckpoint,
  TaskHistoryAccuracy,
  TaskHistoryDelivery,
  type TaskHistoryEvent,
  TaskHistoryEventKind,
  TaskTransferSampleFlag,
} from '@shared/types/task-inspector-activity'
import Database from 'better-sqlite3'
import {
  COMPACTED_TASK_SAMPLE_COUNT,
  compactTaskTransferSamples,
  MAX_PERSISTED_TASK_SAMPLES,
} from '../src/core/inspector-activity/compaction'
import { TaskInspectorActivityStore } from '../src/core/inspector-activity/task-inspector-activity-store'
import { migrate } from '../src/core/session/migrations'
import { buildActivityTimelineModel } from '../src/renderer/routes/downloads/inspector/activity-timeline-model'
import { makeDownloadTask } from '../src/test-utils/task'

const TASK_COUNT = 10_000
const SAMPLES_PER_TASK = 96
const EVENTS_PER_TASK = 20
const ACTIVE_TASK_COUNT = 10
const ADVERSARIAL_TIMELINE_EVENTS = 1_000
const WARMUP_COUNT = 20
const MEASUREMENT_COUNT = 100
const BASE_MS = Date.UTC(2026, 0, 1)

const DATABASE_BUDGET_BYTES = 128 * 1024 * 1024
const SNAPSHOT_P95_BUDGET_MS = 25
const CHECKPOINT_P95_BUDGET_MS = 20
const COMPACTION_P95_BUDGET_MS = 5
const TIMELINE_P95_BUDGET_MS = 16
const MAX_TIMELINE_NODES = 7
const MAX_TIMELINE_MARKERS = 8

interface TimingSummary {
  warmups: number
  samples: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

interface BenchmarkResult<T> {
  timing: TimingSummary
  last: T
}

interface PlanReport {
  summary: readonly string[]
  historyChronological: readonly string[]
  historyPruning: readonly string[]
  samplesChronological: readonly string[]
  samplesLatest: readonly string[]
}

function taskId(index: number): string {
  return `profile-task-${index.toString().padStart(5, '0')}`
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  )
  return sorted[index] ?? Number.POSITIVE_INFINITY
}

function rounded(value: number): number {
  return Number(value.toFixed(3))
}

function benchmark<T>(operation: () => T): BenchmarkResult<T> {
  let last = operation()
  for (let index = 1; index < WARMUP_COUNT; index += 1) {
    last = operation()
  }

  const samples: number[] = []
  for (let index = 0; index < MEASUREMENT_COUNT; index += 1) {
    const startedAt = performance.now()
    last = operation()
    samples.push(performance.now() - startedAt)
  }
  samples.sort((left, right) => left - right)
  return {
    timing: {
      warmups: WARMUP_COUNT,
      samples: MEASUREMENT_COUNT,
      p50Ms: rounded(percentile(samples, 0.5)),
      p95Ms: rounded(percentile(samples, 0.95)),
      maxMs: rounded(samples.at(-1) ?? Number.POSITIVE_INFINITY),
    },
    last,
  }
}

function rowCount(db: Database.Database, table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number
    }
  ).count
}

function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

function queryPlan(
  db: Database.Database,
  sql: string,
  ...bindings: readonly unknown[]
): string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{
      detail: string
    }>
  ).map((row) => row.detail)
}

function seedFixture(db: Database.Database): number {
  const insertTask = db.prepare(
    `INSERT INTO tasks (
      motrix_id,
      name,
      task_type,
      agg_status,
      created_at,
      updated_at
    ) VALUES (?, ?, 'http', ?, ?, ?)`
  )
  const insertSummary = db.prepare(
    `INSERT INTO task_inspector_activity (
      motrix_id,
      tracking_started_at,
      revision,
      last_event_ordinal,
      active_ms,
      download_active_ms,
      estimated_download_bytes,
      estimated_upload_bytes,
      peak_download_bps,
      peak_upload_bps,
      raw_sample_count,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertSample = db.prepare(
    `INSERT INTO task_transfer_samples (
      motrix_id,
      sampled_at,
      download_bps,
      upload_bps,
      flags
    ) VALUES (?, ?, ?, ?, 0)`
  )
  const insertEvent = db.prepare(
    `INSERT INTO task_history_events (
      motrix_id,
      event_ordinal,
      event_key,
      kind,
      from_status,
      to_status,
      occurred_at,
      accuracy
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'exact')`
  )

  const startedAt = performance.now()
  db.transaction(() => {
    for (let taskIndex = 0; taskIndex < TASK_COUNT; taskIndex += 1) {
      const id = taskId(taskIndex)
      const active = taskIndex >= TASK_COUNT - ACTIVE_TASK_COUNT
      insertTask.run(
        id,
        `Profile task ${taskIndex}`,
        active ? TaskStatus.Downloading : TaskStatus.Queued,
        BigInt(BASE_MS),
        BigInt(BASE_MS + EVENTS_PER_TASK * 1_000)
      )
      insertSummary.run(
        id,
        BigInt(BASE_MS),
        BigInt(EVENTS_PER_TASK),
        BigInt(EVENTS_PER_TASK),
        60_000n,
        60_000n,
        120_000_000n,
        12_000_000n,
        8_000_000n,
        800_000n,
        BigInt(SAMPLES_PER_TASK),
        BigInt(BASE_MS + EVENTS_PER_TASK * 1_000)
      )

      for (
        let sampleIndex = 0;
        sampleIndex < SAMPLES_PER_TASK;
        sampleIndex += 1
      ) {
        insertSample.run(
          id,
          BigInt(BASE_MS + sampleIndex * 1_000),
          BigInt(500_000 + ((taskIndex + sampleIndex) % 64) * 125_000),
          BigInt(50_000 + ((taskIndex * 3 + sampleIndex) % 32) * 25_000)
        )
      }

      for (
        let eventOrdinal = 1;
        eventOrdinal <= EVENTS_PER_TASK;
        eventOrdinal += 1
      ) {
        const added = eventOrdinal === 1
        const started = eventOrdinal === 2
        const paused = !added && !started && eventOrdinal % 2 === 1
        insertEvent.run(
          id,
          BigInt(eventOrdinal),
          `event-${eventOrdinal}`,
          added
            ? TaskHistoryEventKind.Added
            : started
              ? TaskHistoryEventKind.Started
              : paused
                ? TaskHistoryEventKind.Paused
                : TaskHistoryEventKind.Resumed,
          added
            ? null
            : started
              ? TaskStatus.Queued
              : paused
                ? TaskStatus.Downloading
                : TaskStatus.Paused,
          added
            ? TaskStatus.Queued
            : paused
              ? TaskStatus.Paused
              : TaskStatus.Downloading,
          BigInt(BASE_MS + eventOrdinal * 1_000)
        )
      }
    }
  })()
  return rounded(performance.now() - startedAt)
}

function compactionFixture() {
  return Array.from({ length: 97 }, (_, index) => ({
    t: BASE_MS + index * 1_000,
    down: index === 31 ? 12_000_000 : (index % 11) * 250_000,
    up: index === 67 ? 4_000_000 : (index % 7) * 100_000,
    flags:
      index === 40
        ? TaskTransferSampleFlag.CoverageGap
        : index === 96
          ? TaskTransferSampleFlag.Terminal
          : index % 13 === 0
            ? TaskTransferSampleFlag.StatusBoundary
            : 0,
  }))
}

function timelineFixture(): TaskHistoryEvent[] {
  return Array.from(
    { length: ADVERSARIAL_TIMELINE_EVENTS },
    (_, index): TaskHistoryEvent => {
      const ordinal = index + 1
      const added = ordinal === 1
      const started = ordinal === 2
      const failed = ordinal === ADVERSARIAL_TIMELINE_EVENTS
      const paused = !added && !started && !failed && ordinal % 2 === 1
      return {
        eventOrdinal: ordinal,
        eventKey: `timeline-${ordinal}`,
        kind: added
          ? TaskHistoryEventKind.Added
          : started
            ? TaskHistoryEventKind.Started
            : failed
              ? TaskHistoryEventKind.Failed
              : paused
                ? TaskHistoryEventKind.Paused
                : TaskHistoryEventKind.Resumed,
        fromStatus: added
          ? null
          : started
            ? TaskStatus.Queued
            : paused
              ? TaskStatus.Downloading
              : TaskStatus.Paused,
        toStatus: added
          ? TaskStatus.Queued
          : failed
            ? TaskStatus.Error
            : paused
              ? TaskStatus.Paused
              : TaskStatus.Downloading,
        occurredAt: BASE_MS + Math.floor(ordinal / 3),
        accuracy: TaskHistoryAccuracy.Exact,
        errorCode: failed ? 'PROFILE_FAILURE' : null,
        errorMessage: failed ? 'adversarial terminal event' : null,
      }
    }
  )
}

function checkpointInputs(
  activeTaskIds: readonly string[],
  updatedAt: number
): TaskActivityCheckpoint[] {
  return activeTaskIds.map((id, index) => ({
    taskId: id,
    updatedAt,
    activeMsDelta: 30_000,
    downloadActiveMsDelta: 30_000,
    estimatedDownloadBytesDelta: 3_000_000n,
    estimatedUploadBytesDelta: 300_000n,
    peakDownloadBps: 8_000_000 + index,
    peakUploadBps: 800_000 + index,
    rawSampleCountDelta: 1,
    samples: [
      {
        t: updatedAt,
        down: 2_000_000 + index,
        up: 200_000 + index,
        flags: 0,
      },
    ],
  }))
}

function appendCapCase(store: TaskInspectorActivityStore, id: string): void {
  for (
    let eventOrdinal = EVENTS_PER_TASK + 1;
    eventOrdinal <= 513;
    eventOrdinal += 1
  ) {
    const paused = eventOrdinal % 2 === 1
    const revision = store.recordTransition({
      taskId: id,
      eventOrdinal,
      eventKey: `event-${eventOrdinal}`,
      runtimeGeneration: 'profile-runtime',
      occurredAt: BASE_MS + eventOrdinal * 1_000,
      occurredMonotonicMs: eventOrdinal * 1_000,
      kind: paused ? TaskHistoryEventKind.Paused : TaskHistoryEventKind.Resumed,
      fromStatus: paused ? TaskStatus.Downloading : TaskStatus.Paused,
      toStatus: paused ? TaskStatus.Paused : TaskStatus.Downloading,
      accuracy: TaskHistoryAccuracy.Exact,
      delivery: TaskHistoryDelivery.Initial,
      errorCode: null,
      errorMessage: null,
    })
    if (!revision) {
      throw new Error(`Cap fixture event ${eventOrdinal} was not recorded`)
    }
  }
}

function main(): void {
  const fixtureDir = mkdtempSync(
    path.join(tmpdir(), 'motrix-activity-profile-')
  )
  const databasePath = path.join(fixtureDir, 'activity-profile.db')
  const violations: string[] = []
  let db: Database.Database | undefined

  try {
    db = new Database(databasePath)
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('temp_store = MEMORY')
    db.pragma('cache_size = -131072')
    migrate(db)

    const seedMs = seedFixture(db)
    const initialRows = {
      tasks: rowCount(db, 'tasks'),
      summaries: rowCount(db, 'task_inspector_activity'),
      samples: rowCount(db, 'task_transfer_samples'),
      events: rowCount(db, 'task_history_events'),
      activeTasks: (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM tasks
             WHERE agg_status = 'downloading'`
          )
          .get() as { count: number }
      ).count,
    }

    if (initialRows.tasks !== TASK_COUNT) {
      violations.push(
        `fixture has ${initialRows.tasks} tasks; expected ${TASK_COUNT}`
      )
    }
    if (initialRows.summaries !== TASK_COUNT) {
      violations.push(
        `fixture has ${initialRows.summaries} summaries; expected ${TASK_COUNT}`
      )
    }
    if (initialRows.samples !== TASK_COUNT * SAMPLES_PER_TASK) {
      violations.push(
        `fixture has ${initialRows.samples} samples; expected ` +
          `${TASK_COUNT * SAMPLES_PER_TASK}`
      )
    }
    if (initialRows.events !== TASK_COUNT * EVENTS_PER_TASK) {
      violations.push(
        `fixture has ${initialRows.events} events; expected ` +
          `${TASK_COUNT * EVENTS_PER_TASK}`
      )
    }
    if (initialRows.activeTasks !== ACTIVE_TASK_COUNT) {
      violations.push(
        `fixture has ${initialRows.activeTasks} active tasks; expected ` +
          `${ACTIVE_TASK_COUNT}`
      )
    }

    db.pragma('wal_checkpoint(TRUNCATE)')
    db.exec('VACUUM')
    db.pragma('wal_checkpoint(TRUNCATE)')

    const plans: PlanReport = {
      summary: queryPlan(
        db,
        `SELECT * FROM task_inspector_activity WHERE motrix_id = ?`,
        taskId(0)
      ),
      historyChronological: queryPlan(
        db,
        `SELECT * FROM task_history_events
         WHERE motrix_id = ?
         ORDER BY event_ordinal
         LIMIT 512`,
        taskId(0)
      ),
      historyPruning: queryPlan(
        db,
        `SELECT event_id FROM task_history_events
         WHERE motrix_id = ?
         ORDER BY event_ordinal DESC
         LIMIT 1`,
        taskId(0)
      ),
      samplesChronological: queryPlan(
        db,
        `SELECT * FROM task_transfer_samples
         WHERE motrix_id = ?
         ORDER BY sampled_at`,
        taskId(0)
      ),
      samplesLatest: queryPlan(
        db,
        `SELECT * FROM task_transfer_samples
         WHERE motrix_id = ?
         ORDER BY sampled_at DESC
         LIMIT 1`,
        taskId(0)
      ),
    }

    const expectedPlans: Array<{
      label: keyof PlanReport
      pattern: RegExp
    }> = [
      { label: 'summary', pattern: /USING PRIMARY KEY.*motrix_id/i },
      {
        label: 'historyChronological',
        pattern: /USING INDEX sqlite_autoindex_task_history_events_2/i,
      },
      {
        label: 'historyPruning',
        pattern:
          /USING (?:COVERING )?INDEX sqlite_autoindex_task_history_events_2/i,
      },
      {
        label: 'samplesChronological',
        pattern: /USING PRIMARY KEY.*motrix_id/i,
      },
      {
        label: 'samplesLatest',
        pattern: /USING PRIMARY KEY.*motrix_id/i,
      },
    ]
    for (const expected of expectedPlans) {
      const details = plans[expected.label]
      if (!details.some((detail) => expected.pattern.test(detail))) {
        violations.push(
          `${expected.label} did not use its declared task-prefixed index: ` +
            details.join(' | ')
        )
      }
      if (
        details.some((detail) =>
          /\bSCAN task_(?:inspector_activity|history_events|transfer_samples)\b/i.test(
            detail
          )
        )
      ) {
        violations.push(
          `${expected.label} performs a full per-task table scan: ` +
            details.join(' | ')
        )
      }
    }

    const store = new TaskInspectorActivityStore(db)
    const queryIds = {
      early: taskId(1),
      middle: taskId(Math.floor(TASK_COUNT / 2)),
      late: taskId(TASK_COUNT - 1),
    }
    const queryBenchmarks = {
      early: benchmark(() => store.snapshot(queryIds.early)),
      middle: benchmark(() => store.snapshot(queryIds.middle)),
      late: benchmark(() => store.snapshot(queryIds.late)),
    }
    for (const [position, result] of Object.entries(queryBenchmarks)) {
      if (
        !result.last ||
        result.last.lifetime.points.length !== SAMPLES_PER_TASK ||
        result.last.timeline.events.length !== EVENTS_PER_TASK
      ) {
        violations.push(
          `${position} snapshot returned an invalid fixture shape`
        )
      }
      if (result.timing.p95Ms >= SNAPSHOT_P95_BUDGET_MS) {
        violations.push(
          `${position} snapshot p95 ${result.timing.p95Ms}ms must be below ` +
            `${SNAPSHOT_P95_BUDGET_MS}ms`
        )
      }
    }

    const compactInput = compactionFixture()
    const compaction = benchmark(() => compactTaskTransferSamples(compactInput))
    if (compaction.last.length !== COMPACTED_TASK_SAMPLE_COUNT) {
      violations.push(
        `97-point compaction returned ${compaction.last.length}; expected ` +
          `${COMPACTED_TASK_SAMPLE_COUNT}`
      )
    }
    if (compaction.timing.p95Ms >= COMPACTION_P95_BUDGET_MS) {
      violations.push(
        `97→72 compaction p95 ${compaction.timing.p95Ms}ms must be below ` +
          `${COMPACTION_P95_BUDGET_MS}ms`
      )
    }

    const timelineEvents = timelineFixture()
    const timelineTask = makeDownloadTask({
      id: 'timeline-profile',
      status: TaskStatus.Error,
      updatedAt: BASE_MS + ADVERSARIAL_TIMELINE_EVENTS,
      finishedAt: BASE_MS + ADVERSARIAL_TIMELINE_EVENTS,
    })
    const timeline = benchmark(() =>
      buildActivityTimelineModel({
        events: timelineEvents,
        task: timelineTask,
        availableWidth: 914,
      })
    )
    if (timeline.last.nodes.length > MAX_TIMELINE_NODES) {
      violations.push(
        `timeline projected ${timeline.last.nodes.length} top-level nodes; ` +
          `maximum is ${MAX_TIMELINE_NODES}`
      )
    }
    if (timeline.last.markerGroups.length > MAX_TIMELINE_MARKERS) {
      violations.push(
        `timeline projected ${timeline.last.markerGroups.length} markers; ` +
          `maximum is ${MAX_TIMELINE_MARKERS}`
      )
    }
    if (timeline.timing.p95Ms >= TIMELINE_P95_BUDGET_MS) {
      violations.push(
        `1,000-event timeline p95 ${timeline.timing.p95Ms}ms must be below ` +
          `${TIMELINE_P95_BUDGET_MS}ms`
      )
    }

    const activeTaskIds = Array.from(
      { length: ACTIVE_TASK_COUNT },
      (_, index) => taskId(TASK_COUNT - ACTIVE_TASK_COUNT + index)
    )
    const firstCheckpointAt = BASE_MS + SAMPLES_PER_TASK * 1_000
    const firstCheckpoint = store.checkpointBatch(
      checkpointInputs(activeTaskIds, firstCheckpointAt)
    )
    if (
      firstCheckpoint.revisions.length !== ACTIVE_TASK_COUNT ||
      firstCheckpoint.omissions.length !== 0
    ) {
      violations.push(
        `initial ten-task checkpoint committed ` +
          `${firstCheckpoint.revisions.length} tasks with ` +
          `${firstCheckpoint.omissions.length} omissions`
      )
    }
    for (const id of activeTaskIds) {
      const count = (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM task_transfer_samples
             WHERE motrix_id = ?`
          )
          .get(id) as { count: number }
      ).count
      if (count !== COMPACTED_TASK_SAMPLE_COUNT) {
        violations.push(
          `${id} persisted ${count} samples after 97→72 store compaction`
        )
      }
    }

    let checkpointSequence = 0
    const checkpoints = benchmark(() => {
      checkpointSequence += 1
      return store.checkpointBatch(
        checkpointInputs(
          activeTaskIds,
          BASE_MS + (SAMPLES_PER_TASK + checkpointSequence) * 1_000
        )
      )
    })
    if (
      checkpoints.last.revisions.length !== ACTIVE_TASK_COUNT ||
      checkpoints.last.omissions.length !== 0
    ) {
      violations.push(
        `ten-task checkpoint committed ${checkpoints.last.revisions.length} ` +
          `tasks with ${checkpoints.last.omissions.length} omissions`
      )
    }
    if (checkpoints.timing.p95Ms >= CHECKPOINT_P95_BUDGET_MS) {
      violations.push(
        `ten-task checkpoint p95 ${checkpoints.timing.p95Ms}ms must be below ` +
          `${CHECKPOINT_P95_BUDGET_MS}ms`
      )
    }

    const capTaskId = taskId(0)
    appendCapCase(store, capTaskId)
    const capSnapshot = store.snapshot(capTaskId)
    const capRows = (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM task_history_events
           WHERE motrix_id = ?`
        )
        .get(capTaskId) as { count: number }
    ).count
    if (!capSnapshot || capRows !== 512) {
      violations.push(
        `event #513 left ${capRows} durable rows; expected exactly 512`
      )
    } else {
      if (
        capSnapshot.timeline.events[0]?.kind !== TaskHistoryEventKind.Added ||
        capSnapshot.timeline.events.some((event) => event.eventOrdinal === 2)
      ) {
        violations.push(
          'event #513 did not preserve Added and prune the oldest other event'
        )
      }
      if (
        capSnapshot.summary.lastEventOrdinal !== 513 ||
        capSnapshot.summary.historyDroppedCount !== 1 ||
        capSnapshot.summary.historyTruncatedAt !== BASE_MS + 2_000
      ) {
        violations.push(
          'event #513 produced incorrect watermark/truncation metadata'
        )
      }
    }

    const maxSamples = (
      db
        .prepare(
          `SELECT MAX(sample_count) AS max_count
           FROM (
             SELECT COUNT(*) AS sample_count
             FROM task_transfer_samples
             GROUP BY motrix_id
           )`
        )
        .get() as { max_count: number }
    ).max_count
    if (maxSamples > MAX_PERSISTED_TASK_SAMPLES) {
      violations.push(
        `a task persisted ${maxSamples} samples; maximum is ` +
          `${MAX_PERSISTED_TASK_SAMPLES}`
      )
    }

    db.pragma('wal_checkpoint(TRUNCATE)')
    db.exec('VACUUM')
    db.pragma('wal_checkpoint(TRUNCATE)')

    const pageSize = (
      db.prepare('PRAGMA page_size').get() as { page_size: number }
    ).page_size
    const pageCount = (
      db.prepare('PRAGMA page_count').get() as { page_count: number }
    ).page_count
    const freelistCount = (
      db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }
    ).freelist_count
    const databaseBytes = fileSize(databasePath)
    const finalRows = {
      tasks: rowCount(db, 'tasks'),
      summaries: rowCount(db, 'task_inspector_activity'),
      samples: rowCount(db, 'task_transfer_samples'),
      events: rowCount(db, 'task_history_events'),
      maxSamplesPerTask: maxSamples,
      capTaskEvents: capRows,
    }
    const persistedFixtureRows =
      finalRows.tasks +
      finalRows.summaries +
      finalRows.samples +
      finalRows.events
    const snapshotPayloadBytes = Object.fromEntries(
      Object.entries(queryBenchmarks).map(([position, result]) => [
        position,
        result.last ? Buffer.byteLength(JSON.stringify(result.last)) : 0,
      ])
    )

    if (databaseBytes >= DATABASE_BUDGET_BYTES) {
      violations.push(
        `database is ${(databaseBytes / 1024 / 1024).toFixed(2)} MiB; must be ` +
          `below ${DATABASE_BUDGET_BYTES / 1024 / 1024} MiB`
      )
    }

    const report = {
      runtime: {
        node: process.version,
        v8: process.versions.v8,
        platform: platform(),
        release: release(),
        arch: arch(),
        cpuCount: cpus().length,
        cpuModel: cpus()[0]?.model ?? 'unknown',
      },
      fixture: {
        tasks: TASK_COUNT,
        samplesPerTask: SAMPLES_PER_TASK,
        eventsPerTask: EVENTS_PER_TASK,
        activeTasks: ACTIVE_TASK_COUNT,
        seedMs,
        initialRows,
        finalRows,
      },
      measurements: {
        snapshotEarly: queryBenchmarks.early.timing,
        snapshotMiddle: queryBenchmarks.middle.timing,
        snapshotLate: queryBenchmarks.late.timing,
        checkpointTenTasks: checkpoints.timing,
        compact97To72: compaction.timing,
        projectTimeline1000Events: timeline.timing,
      },
      budgetsMs: {
        snapshotP95Below: SNAPSHOT_P95_BUDGET_MS,
        checkpointP95Below: CHECKPOINT_P95_BUDGET_MS,
        compactionP95Below: COMPACTION_P95_BUDGET_MS,
        timelineP95Below: TIMELINE_P95_BUDGET_MS,
      },
      projectionCaps: {
        timelineNodes: timeline.last.nodes.length,
        timelineNodeMaximum: MAX_TIMELINE_NODES,
        timelineMarkers: timeline.last.markerGroups.length,
        timelineMarkerMaximum: MAX_TIMELINE_MARKERS,
      },
      storage: {
        databaseBytes,
        databaseMiB: rounded(databaseBytes / 1024 / 1024),
        walBytes: fileSize(`${databasePath}-wal`),
        shmBytes: fileSize(`${databasePath}-shm`),
        pageSize,
        pageCount,
        freelistCount,
        logicalBytes: pageSize * pageCount,
        averageBytesPerTask: rounded(databaseBytes / TASK_COUNT),
        averageBytesPerPersistedRow: rounded(
          databaseBytes / persistedFixtureRows
        ),
        snapshotPayloadBytes,
        budgetBytesBelow: DATABASE_BUDGET_BYTES,
      },
      queryPlans: plans,
      passed: violations.length === 0,
      violations,
    }

    console.log(
      `[task-inspector-activity-profile] ${JSON.stringify(report, null, 2)}`
    )
    if (violations.length > 0) {
      throw new Error(
        `Task Inspector Activity profile failed:\n- ${violations.join('\n- ')}`
      )
    }
  } finally {
    db?.close()
    rmSync(fixtureDir, { recursive: true, force: true })
  }
}

main()
