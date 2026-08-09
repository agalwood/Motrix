import type { ElectronApplication, Page } from '@playwright/test'
import type { SupportedLocale } from '@shared/constants/locales'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'

export const TASK_INSPECTOR_ACTIVITY_NOW = Date.UTC(2026, 6, 29, 13, 30, 0)

export const TASK_INSPECTOR_ACTIVITY_IDS = {
  rich: 'e2e-inspector-rich',
  error: 'e2e-inspector-error',
  zero: 'e2e-inspector-zero',
  empty: 'e2e-inspector-empty',
  single: 'e2e-inspector-single',
  compacted: 'e2e-inspector-compacted',
  truncated: 'e2e-inspector-truncated',
} as const

export const TASK_INSPECTOR_ACTIVITY_NAMES = {
  rich: 'Motrix Activity Reference.iso',
  error: 'Failed Activity Fixture.zip',
  zero: 'All-zero Activity Fixture.bin',
  empty: 'Empty Activity Fixture.bin',
  single: 'Single-point Activity Fixture.bin',
  compacted: 'Compacted Activity Fixture.bin',
  truncated: 'Truncated Activity Fixture.bin',
} as const

type FixtureTaskKey = keyof typeof TASK_INSPECTOR_ACTIVITY_IDS

interface SeedTask {
  id: string
  name: string
  status: 'completed' | 'error'
  createdAt: number
  updatedAt: number
  finishedAt: number
  errorCode: string | null
  errorMessage: string | null
}

interface SeedEvent {
  taskId: string
  ordinal: number
  key: string
  kind:
    | 'added'
    | 'started'
    | 'paused'
    | 'resumed'
    | 'stage_changed'
    | 'completed'
    | 'failed'
    | 'observed_state'
  fromStatus: string | null
  toStatus: string
  occurredAt: number
  accuracy: 'exact' | 'recovered'
  errorCode: string | null
  errorMessage: string | null
}

interface SeedSample {
  taskId: string
  sampledAt: number
  down: number
  up: number
  flags: number
}

interface SeedSummary {
  taskId: string
  trackingStartedAt: number
  coverageGapAt: number | null
  revision: number
  lastEventOrdinal: number
  activeMs: number
  downloadActiveMs: number
  estimatedDownloadBytes: number
  estimatedUploadBytes: number
  peakDownloadBps: number
  peakUploadBps: number
  rawSampleCount: number
  historyDroppedCount: number
  historyTruncatedAt: number | null
  updatedAt: number
}

interface ActivitySeedPayload {
  tasks: SeedTask[]
  events: SeedEvent[]
  samples: SeedSample[]
  summaries: SeedSummary[]
  userDataDir: string
}

interface FixtureSqliteStatement {
  run(...values: unknown[]): { changes: number }
}

interface FixtureSqliteDatabase {
  close(): void
  pragma(value: string): unknown
  prepare(sql: string): FixtureSqliteStatement
  transaction<T extends (...args: never[]) => unknown>(fn: T): T
}

interface FixtureSqliteConstructor {
  new (filename: string): FixtureSqliteDatabase
}

function task(key: FixtureTaskKey): SeedTask {
  const isError = key === 'error'
  const offset = Object.keys(TASK_INSPECTOR_ACTIVITY_IDS).indexOf(key) * 60_000
  return {
    id: TASK_INSPECTOR_ACTIVITY_IDS[key],
    name: TASK_INSPECTOR_ACTIVITY_NAMES[key],
    status: isError ? 'error' : 'completed',
    createdAt: TASK_INSPECTOR_ACTIVITY_NOW - 7_200_000 + offset,
    updatedAt: TASK_INSPECTOR_ACTIVITY_NOW - 60_000 + offset,
    finishedAt: TASK_INSPECTOR_ACTIVITY_NOW - 60_000 + offset,
    errorCode: isError ? 'NETWORK_ERROR' : null,
    errorMessage: isError
      ? 'The remote server closed the connection before the transfer completed.'
      : null,
  }
}

function ordinaryEvents(item: SeedTask): SeedEvent[] {
  const start = item.createdAt
  const failed = item.status === 'error'
  return [
    {
      taskId: item.id,
      ordinal: 1,
      key: `${item.id}:added`,
      kind: 'added',
      fromStatus: null,
      toStatus: 'queued',
      occurredAt: start,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    },
    {
      taskId: item.id,
      ordinal: 2,
      key: `${item.id}:started`,
      kind: 'started',
      fromStatus: 'queued',
      toStatus: 'downloading',
      occurredAt: start + 300_000,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    },
    {
      taskId: item.id,
      ordinal: 3,
      key: `${item.id}:paused`,
      kind: 'paused',
      fromStatus: 'downloading',
      toStatus: 'paused',
      occurredAt: start + 2_400_000,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    },
    {
      taskId: item.id,
      ordinal: 4,
      key: `${item.id}:resumed`,
      kind: 'resumed',
      fromStatus: 'paused',
      toStatus: 'downloading',
      occurredAt: start + 3_000_000,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    },
    {
      taskId: item.id,
      ordinal: 5,
      key: `${item.id}:finalizing`,
      kind: 'stage_changed',
      fromStatus: 'downloading',
      toStatus: 'finalizing',
      occurredAt: item.finishedAt - 120_000,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    },
    {
      taskId: item.id,
      ordinal: 6,
      key: `${item.id}:terminal`,
      kind: failed ? 'failed' : 'completed',
      fromStatus: 'finalizing',
      toStatus: failed ? 'error' : 'completed',
      occurredAt: item.finishedAt,
      accuracy: 'exact',
      errorCode: item.errorCode,
      errorMessage: item.errorMessage,
    },
  ]
}

function samplesFor(
  taskId: string,
  count: number,
  allZero = false
): SeedSample[] {
  const start = TASK_INSPECTOR_ACTIVITY_NOW - 6_600_000
  return Array.from({ length: count }, (_, index) => {
    const phase = index / Math.max(1, count - 1)
    const down = allZero
      ? 0
      : Math.round(
          1_100_000 +
            Math.sin(phase * Math.PI * 5) * 850_000 +
            phase * 2_900_000
        )
    const up = allZero
      ? 0
      : Math.round(120_000 + Math.cos(phase * Math.PI * 4) * 90_000)
    return {
      taskId,
      sampledAt: start + index * 75_000,
      down: Math.max(0, down),
      up: Math.max(0, up),
      flags: index === 0 ? 1 : index === count - 1 ? 2 : 0,
    }
  })
}

function buildSeed(userDataDir: string): ActivitySeedPayload {
  const tasks = (
    Object.keys(TASK_INSPECTOR_ACTIVITY_IDS) as FixtureTaskKey[]
  ).map(task)
  const ordinary = tasks.filter(
    (item) => item.id !== TASK_INSPECTOR_ACTIVITY_IDS.truncated
  )
  const events = ordinary.flatMap((item) => {
    const itemEvents = ordinaryEvents(item)
    // The approved visual direction is an active task with a coherent
    // Added → Started → Paused → Resumed history and a separate Now endpoint.
    // The durable DB parent remains terminal so startup recovery is hermetic;
    // publishTaskInspectorPresentation supplies the active renderer state.
    return item.id === TASK_INSPECTOR_ACTIVITY_IDS.rich
      ? itemEvents.slice(0, 4)
      : itemEvents
  })
  const truncatedTask = tasks.find(
    (item) => item.id === TASK_INSPECTOR_ACTIVITY_IDS.truncated
  )
  if (!truncatedTask) throw new Error('truncated fixture task is missing')

  events.push({
    taskId: truncatedTask.id,
    ordinal: 1,
    key: `${truncatedTask.id}:added`,
    kind: 'added',
    fromStatus: null,
    toStatus: 'queued',
    occurredAt: truncatedTask.createdAt,
    accuracy: 'exact',
    errorCode: null,
    errorMessage: null,
  })
  for (let ordinal = 3; ordinal <= 513; ordinal += 1) {
    const paused = ordinal % 2 === 1
    events.push({
      taskId: truncatedTask.id,
      ordinal,
      key: `${truncatedTask.id}:${ordinal}`,
      kind: paused ? 'paused' : 'resumed',
      fromStatus: paused ? 'downloading' : 'paused',
      toStatus: paused ? 'paused' : 'downloading',
      occurredAt: truncatedTask.createdAt + ordinal * 10_000,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    })
  }

  const samples = [
    ...samplesFor(TASK_INSPECTOR_ACTIVITY_IDS.rich, 48),
    ...samplesFor(TASK_INSPECTOR_ACTIVITY_IDS.error, 18),
    ...samplesFor(TASK_INSPECTOR_ACTIVITY_IDS.zero, 12, true),
    ...samplesFor(TASK_INSPECTOR_ACTIVITY_IDS.single, 1),
    ...samplesFor(TASK_INSPECTOR_ACTIVITY_IDS.compacted, 72),
    ...samplesFor(TASK_INSPECTOR_ACTIVITY_IDS.truncated, 24),
  ]

  const sampleCount = (taskId: string) =>
    samples.filter((sample) => sample.taskId === taskId).length
  const summaries = tasks.map<SeedSummary>((item) => {
    const itemEvents = events.filter((event) => event.taskId === item.id)
    const itemSamples = samples.filter((sample) => sample.taskId === item.id)
    const rawSampleCount =
      item.id === TASK_INSPECTOR_ACTIVITY_IDS.compacted
        ? 97
        : itemSamples.length
    return {
      taskId: item.id,
      trackingStartedAt: item.createdAt,
      coverageGapAt:
        item.id === TASK_INSPECTOR_ACTIVITY_IDS.compacted
          ? item.createdAt + 1_800_000
          : null,
      revision: 20 + sampleCount(item.id),
      lastEventOrdinal:
        item.id === TASK_INSPECTOR_ACTIVITY_IDS.truncated
          ? 513
          : (itemEvents.at(-1)?.ordinal ?? 0),
      activeMs: 5_400_000,
      downloadActiveMs: 4_800_000,
      estimatedDownloadBytes: 18_900_000_000,
      estimatedUploadBytes: 870_000_000,
      peakDownloadBps: Math.max(0, ...itemSamples.map((sample) => sample.down)),
      peakUploadBps: Math.max(0, ...itemSamples.map((sample) => sample.up)),
      rawSampleCount,
      historyDroppedCount:
        item.id === TASK_INSPECTOR_ACTIVITY_IDS.truncated ? 1 : 0,
      historyTruncatedAt:
        item.id === TASK_INSPECTOR_ACTIVITY_IDS.truncated
          ? item.createdAt + 20_000
          : null,
      updatedAt: item.updatedAt,
    }
  })

  return { tasks, events, samples, summaries, userDataDir }
}

/**
 * Seed through Electron's process so better-sqlite3 uses Electron's native
 * ABI. Call this after a preparation launch has completed migrations, then
 * close that launch before starting the verifying app.
 */
export async function seedTaskInspectorActivity(
  electronApp: ElectronApplication,
  userDataDir: string
): Promise<void> {
  await electronApp.evaluate(({ app }, payload: ActivitySeedPayload) => {
    const { createRequire } = process.getBuiltinModule('module')
    const path = process.getBuiltinModule('path')
    const requireFromApp = createRequire(
      path.join(app.getAppPath(), 'package.json')
    )
    const Database = requireFromApp(
      'better-sqlite3'
    ) as FixtureSqliteConstructor
    const database = new Database(path.join(payload.userDataDir, 'motrix.db'))
    database.pragma('busy_timeout = 5000')
    database.pragma('foreign_keys = ON')

    const deleteFixtures = database.prepare(
      "DELETE FROM tasks WHERE motrix_id GLOB 'e2e-inspector-*'"
    )
    const insertTask = database.prepare(
      `INSERT INTO tasks (
          motrix_id, name, kind, task_type, created_at, updated_at,
          final_path, final_name, total_bytes, downloaded_bytes,
          size_when_done, file_count, agg_status, finished_at,
          error_message, error_code, source
        ) VALUES (?, ?, 'direct', 'http', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'user')`
    )
    const insertInstance = database.prepare(
      `INSERT INTO task_instances (
          instance_id, motrix_id, gid, phase, status, progress,
          total_bytes, downloaded_bytes, uploaded_bytes, disk_path,
          transition_phase, uris, payload, created_at, updated_at
        ) VALUES (?, ?, NULL, 'http_download', ?, ?, ?, ?, 0, ?, 'idle', '[]', '{}', ?, ?)`
    )
    const insertSummary = database.prepare(
      `INSERT INTO task_inspector_activity (
          motrix_id, tracking_started_at, coverage_gap_at, revision,
          last_event_ordinal, active_ms, download_active_ms,
          estimated_download_bytes, estimated_upload_bytes,
          peak_download_bps, peak_upload_bps, raw_sample_count,
          history_dropped_count, history_truncated_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertEvent = database.prepare(
      `INSERT INTO task_history_events (
          motrix_id, event_ordinal, event_key, kind, from_status, to_status,
          occurred_at, accuracy, error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertSample = database.prepare(
      `INSERT INTO task_transfer_samples (
          motrix_id, sampled_at, download_bps, upload_bps, flags
        ) VALUES (?, ?, ?, ?, ?)`
    )

    try {
      database.transaction(() => {
        deleteFixtures.run()
        for (const item of payload.tasks) {
          const finalPath = `/tmp/${item.name}`
          const totalBytes = 4_294_967_296
          insertTask.run(
            item.id,
            item.name,
            item.createdAt,
            item.updatedAt,
            finalPath,
            item.name,
            totalBytes,
            item.status === 'completed' ? totalBytes : totalBytes / 2,
            totalBytes,
            item.status,
            item.finishedAt,
            item.errorMessage,
            item.errorCode
          )
          insertInstance.run(
            `${item.id}:primary`,
            item.id,
            item.status,
            item.status === 'completed' ? 100 : 50,
            totalBytes,
            item.status === 'completed' ? totalBytes : totalBytes / 2,
            finalPath,
            item.createdAt,
            item.updatedAt
          )
        }
        for (const summary of payload.summaries) {
          insertSummary.run(
            summary.taskId,
            summary.trackingStartedAt,
            summary.coverageGapAt,
            summary.revision,
            summary.lastEventOrdinal,
            summary.activeMs,
            summary.downloadActiveMs,
            summary.estimatedDownloadBytes,
            summary.estimatedUploadBytes,
            summary.peakDownloadBps,
            summary.peakUploadBps,
            summary.rawSampleCount,
            summary.historyDroppedCount,
            summary.historyTruncatedAt,
            summary.updatedAt
          )
        }
        for (const event of payload.events) {
          insertEvent.run(
            event.taskId,
            event.ordinal,
            event.key,
            event.kind,
            event.fromStatus,
            event.toStatus,
            event.occurredAt,
            event.accuracy,
            event.errorCode,
            event.errorMessage
          )
        }
        for (const sample of payload.samples) {
          insertSample.run(
            sample.taskId,
            sample.sampledAt,
            sample.down,
            sample.up,
            sample.flags
          )
        }
      })()
    } finally {
      database.close()
    }
  }, buildSeed(userDataDir))
}

export async function configureTaskInspectorWindow(
  electronApp: ElectronApplication,
  page: Page,
  options: {
    width: number
    height: number
    sidebarExpanded: boolean
    frozenNow?: number
  }
): Promise<{ width: number; height: number; zoomFactor: number; dpr: number }> {
  const bounds = await electronApp.evaluate(
    ({ BrowserWindow }, size: { width: number; height: number }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.isDestroyed() &&
          !candidate.webContents.getURL().includes('w=add-task')
      )
      if (!window) throw new Error('Motrix main window is unavailable')
      window.setSize(size.width, size.height, false)
      window.webContents.setZoomFactor(1)
      const next = window.getBounds()
      return {
        width: next.width,
        height: next.height,
        zoomFactor: window.webContents.getZoomFactor(),
      }
    },
    { width: options.width, height: options.height }
  )
  await page.setViewportSize({
    width: options.width,
    height: options.height,
  })

  await page.addInitScript(
    ({ frozenNow, sidebarExpanded }) => {
      if (typeof frozenNow === 'number') {
        Object.defineProperty(Date, 'now', {
          configurable: true,
          value: () => frozenNow,
        })
      }
      localStorage.setItem('sidebar_state', String(sidebarExpanded))
    },
    {
      frozenNow: options.frozenNow ?? TASK_INSPECTOR_ACTIVITY_NOW,
      sidebarExpanded: options.sidebarExpanded,
    }
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  return {
    ...bounds,
    dpr: await page.evaluate(() => window.devicePixelRatio),
  }
}

export async function updateTaskInspectorAppearance(
  page: Page,
  theme: 'light' | 'dark',
  language: SupportedLocale
): Promise<void> {
  await page.evaluate(
    async ({ theme, language, updateSettingsChannel }) => {
      const api = (
        window as unknown as {
          motrix?: {
            invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
          }
        }
      ).motrix
      if (!api) throw new Error('Motrix preload API is unavailable')
      await api.invoke(updateSettingsChannel, {
        app: { theme, language },
      })
    },
    {
      theme,
      language,
      updateSettingsChannel: Commands.UpdateSettings,
    }
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
}

export async function publishTaskInspectorRevision(
  electronApp: ElectronApplication,
  taskId: string,
  revision: number
): Promise<void> {
  await electronApp.evaluate(
    (
      { webContents },
      payload: { channel: string; taskId: string; revision: number }
    ) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed()) {
          contents.send(payload.channel, {
            taskId: payload.taskId,
            revision: payload.revision,
            reason: 'transition',
          })
        }
      }
    },
    {
      channel: Events.TaskInspectorActivityUpdated,
      taskId,
      revision,
    }
  )
}

/**
 * Publish a deterministic renderer presentation for visual assertions while
 * preserving the real task identity and every non-visual field returned by
 * the production ListTasks query. The live lifecycle test still drives the
 * underlying task through real commands; this helper only makes both current
 * transfer directions stable long enough for a screenshot.
 */
export async function publishTaskInspectorPresentation(
  electronApp: ElectronApplication,
  page: Page,
  options: {
    taskId: string
    status: 'downloading' | 'paused' | 'completed' | 'error'
    downloadSpeed: number
    uploadSpeed: number
    onlyTask?: boolean
  }
): Promise<void> {
  const tasks = await page.evaluate(async (channel) => {
    const api = (
      window as unknown as {
        motrix?: {
          invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
        }
      }
    ).motrix
    if (!api) throw new Error('Motrix preload API is unavailable')
    return (await api.invoke(channel)) as Array<Record<string, unknown>>
  }, Queries.ListTasks)
  const presented = tasks
    .filter((task) => !options.onlyTask || task.id === options.taskId)
    .map((task) =>
      task.id === options.taskId
        ? {
            ...task,
            status: options.status,
            downloadSpeed: options.downloadSpeed,
            uploadSpeed: options.uploadSpeed,
            finishedAt:
              options.status === 'downloading' || options.status === 'paused'
                ? null
                : task.finishedAt,
            errorMessage:
              options.status === 'downloading' || options.status === 'paused'
                ? null
                : task.errorMessage,
          }
        : task
    )

  await electronApp.evaluate(
    (
      { webContents },
      payload: { channel: string; tasks: Array<Record<string, unknown>> }
    ) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed()) {
          contents.send(payload.channel, payload.tasks)
        }
      }
    },
    { channel: Events.TaskUpdated, tasks: presented }
  )
}

export async function setTaskInspectorContentSize(
  electronApp: ElectronApplication,
  page: Page,
  width: number,
  height: number
): Promise<{ width: number; height: number }> {
  await electronApp.evaluate(
    ({ BrowserWindow }, size: { width: number; height: number }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.isDestroyed() &&
          !candidate.webContents.getURL().includes('w=add-task')
      )
      if (!window) throw new Error('Motrix main window is unavailable')
      window.setContentSize(size.width, size.height, false)
    },
    { width, height }
  )
  // macOS constrains a real BrowserWindow to the current work area. Playwright
  // viewport emulation keeps the visual reference deterministic even on a
  // shorter CI display while the test still runs inside the real Electron app.
  await page.setViewportSize({ width, height })

  return page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
}
