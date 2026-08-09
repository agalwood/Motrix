import { performance } from 'node:perf_hooks'
import process from 'node:process'
import Database from 'better-sqlite3'
import {
  createTaskActivitySnapshotSql,
  TaskActivityStore,
  taskActivitySnapshotBindings,
} from '../src/core/activity/task-activity-store'
import { v1 } from '../src/core/session/migrations/v1'

const DAY_MS = 24 * 60 * 60 * 1_000
const BASE_MS = Date.UTC(2025, 0, 1)
const EVENT_COUNT = 100_000
const DAY_COUNT = 371
const WARMUP_COUNT = 20
const SAMPLE_COUNT = 100
const P95_BUDGET_MS = 50
const PAYLOAD_BUDGET_BYTES = 65_536

const days = Array.from({ length: DAY_COUNT }, (_, index) => ({
  dateKey: new Date(BASE_MS + index * DAY_MS).toISOString().slice(0, 10),
  fromMs: BASE_MS + index * DAY_MS,
  toMs: BASE_MS + (index + 1) * DAY_MS,
}))

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ]
}

const db = new Database(':memory:')

try {
  db.transaction(() => v1.up(db))()

  const insert = db.prepare(
    `INSERT INTO task_activity_events (
      motrix_id,
      kind,
      occurred_at,
      accuracy
    ) VALUES (?, ?, ?, ?)`
  )
  db.transaction(() => {
    for (let index = 0; index < EVENT_COUNT; index += 1) {
      insert.run(
        `profile-${index}`,
        index % 3 === 0 ? 'download_completed' : 'submitted',
        BigInt(BASE_MS + (index % 365) * DAY_MS + (index % DAY_MS)),
        index % 11 === 0 ? 'recovered' : 'exact'
      )
    }
  })()

  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${createTaskActivitySnapshotSql(DAY_COUNT)}`)
    .all(...taskActivitySnapshotBindings(days)) as Array<{ detail: string }>
  const usesCoveringIndex = plan.some((row) =>
    row.detail.includes(
      'SEARCH events USING COVERING INDEX idx_task_activity_time'
    )
  )
  const scansEventTable = plan.some((row) => row.detail.includes('SCAN events'))
  if (!usesCoveringIndex || scansEventTable) {
    throw new Error(
      `Unexpected task activity query plan: ${plan
        .map((row) => row.detail)
        .join(' | ')}`
    )
  }

  const store = new TaskActivityStore(db)
  for (let index = 0; index < WARMUP_COUNT; index += 1) {
    store.snapshot(days)
  }

  const samples: number[] = []
  let snapshot = store.snapshot(days)
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const startedAt = performance.now()
    snapshot = store.snapshot(days)
    samples.push(performance.now() - startedAt)
  }
  samples.sort((left, right) => left - right)

  const result = {
    nodeVersion: process.version,
    arch: process.arch,
    events: EVENT_COUNT,
    rows: snapshot.days.length,
    samples: SAMPLE_COUNT,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: samples.at(-1) ?? Number.POSITIVE_INFINITY,
    payloadBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    usesCoveringIndex,
  }

  console.log(`[activity-query-profile] ${JSON.stringify(result)}`)

  if (process.env.MOTRIX_ACTIVITY_PROFILE_GATE === '1') {
    if (result.rows !== DAY_COUNT) {
      throw new Error(
        `Activity query returned ${result.rows} rows; expected ${DAY_COUNT}`
      )
    }
    if (result.p95Ms > P95_BUDGET_MS) {
      throw new Error(
        `Activity query p95 ${result.p95Ms.toFixed(2)}ms exceeds ${P95_BUDGET_MS}ms`
      )
    }
    if (result.payloadBytes >= PAYLOAD_BUDGET_BYTES) {
      throw new Error(
        `Activity payload ${result.payloadBytes} bytes must be below ${PAYLOAD_BUDGET_BYTES} bytes`
      )
    }
  }
} finally {
  db.close()
}
