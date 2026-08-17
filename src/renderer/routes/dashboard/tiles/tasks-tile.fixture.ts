import type { TaskListStatus } from '@renderer/hooks/use-task-list'
import { DownloadErrorCode } from '@shared/errors'
import {
  type BtExtension,
  type DownloadTask,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'

export const TASKS_TILE_FIXTURE_QUERY = 'dashboardTasksFixture'

export const TASKS_TILE_FIXTURE_NAMES = [
  'active-all',
  'history',
  'loading',
  'initial-error',
  'cached-error',
  'empty',
  'offline',
  'long-content',
] as const

export type TasksTileFixtureName = (typeof TASKS_TILE_FIXTURE_NAMES)[number]

export interface TasksTileDataSource {
  tasks: readonly DownloadTask[]
  status: TaskListStatus
  hasReadySnapshot: boolean
  retry(): Promise<void>
}

export interface TasksTileFixture {
  engineOnline: boolean
  clockNow: number
  source: TasksTileDataSource
}

const NOW = Date.UTC(2026, 6, 27, 8, 0, 0)
const EMPTY_INSTANCES: DownloadTask['instances'] = []
Object.freeze(EMPTY_INSTANCES)
const NOOP_RETRY = async (): Promise<void> => {}

function btExtension(ratio: number): BtExtension {
  return {
    peers: 6,
    seeds: 18,
    ratio,
    trackers: [],
    selectedFiles: [],
    peersInSwarm: 24,
    seedsInSwarm: 64,
    announceList: [],
    comment: null,
    isPrivate: false,
    magnetUri: null,
    sequentialDownload: false,
  }
}

function freezeTask(task: DownloadTask): DownloadTask {
  Object.freeze(task.uris)
  Object.freeze(task.instances)
  if (task.bt) {
    Object.freeze(task.bt.trackers)
    Object.freeze(task.bt.selectedFiles)
    Object.freeze(task.bt.announceList)
    Object.freeze(task.bt)
  }
  return Object.freeze(task)
}

function makeTask(
  id: string,
  status: TaskStatus,
  overrides: Partial<DownloadTask> = {}
): DownloadTask {
  const type = overrides.type ?? TaskType.Http
  const kind =
    type === TaskType.Bt || type === TaskType.Magnet
      ? TaskKind.Bt
      : TaskKind.Direct
  const terminal =
    status === TaskStatus.Completed || status === TaskStatus.Error

  return freezeTask({
    id,
    engineTaskId: `gid-${id}`,
    name: `${id}.iso`,
    type,
    status,
    progress: terminal ? 1 : 0.42,
    totalBytes: 4_700_000_000,
    downloadedBytes: terminal ? 4_700_000_000 : 1_974_000_000,
    downloadSpeed: status === TaskStatus.Downloading ? 24_000_000 : 0,
    uploadSpeed: status === TaskStatus.Seeding ? 3_200_000 : 0,
    etaSeconds: status === TaskStatus.Downloading ? 113 : 0,
    saveDir: '/Downloads',
    createdAt: NOW - 60 * 60_000,
    updatedAt: NOW - 2 * 60_000,
    finishedAt: terminal ? NOW - 5 * 60_000 : null,
    errorMessage: null,
    uris: [`https://example.test/${id}`],
    uploadedBytes: status === TaskStatus.Seeding ? 1_200_000_000 : 0,
    uploadedBytesBaseline: 0,
    fileCount: 1,
    connections: 8,
    pieceLength: 1_048_576,
    infoHash: null,
    errorCode: null,
    errorDetailKey: null,
    errorDetailParams: null,
    diagnosisRevision: 0,
    metadataProgress:
      status === TaskStatus.FetchingMetadata
        ? 0.36
        : status === TaskStatus.MetadataReady
          ? 1
          : 0,
    priority: 0,
    category: null,
    dlLimit: 0,
    ulLimit: 0,
    filename: `${id}.iso`,
    sizeWhenDone: terminal ? 4_700_000_000 : 0,
    source: 'user',
    sourceMeta: null,
    diskPath: `/Downloads/${id}.iso.motrix`,
    finalPath: `/Downloads/${id}.iso`,
    finalName: `${id}.iso`,
    transitionPhase: TransitionPhase.Idle,
    torrentMetaPath: null,
    kind,
    instances: EMPTY_INSTANCES,
    ...(kind === TaskKind.Bt ? { bt: btExtension(1.27) } : {}),
    ...overrides,
  })
}

const ACTIVE_TASKS = Object.freeze([
  makeTask('ready-to-choose', TaskStatus.MetadataReady, {
    name: 'Linux distribution — choose files',
    type: TaskType.Magnet,
    priority: 5,
  }),
  makeTask('downloading', TaskStatus.Downloading, {
    name: 'Design Resources 2026.zip',
    type: TaskType.Http,
    priority: 3,
  }),
  makeTask('fetching-metadata', TaskStatus.FetchingMetadata, {
    name: 'Open source archive',
    type: TaskType.Magnet,
  }),
  makeTask('finalizing', TaskStatus.Finalizing, {
    name: 'Conference recording.mp4',
    type: TaskType.Metalink,
    progress: 1,
  }),
  makeTask('seeding', TaskStatus.Seeding, {
    name: 'Community release',
    type: TaskType.Bt,
    progress: 1,
  }),
  makeTask('queued', TaskStatus.Queued, {
    name: 'Queued dataset.tar',
    type: TaskType.Ftp,
    progress: 0,
  }),
  makeTask('paused', TaskStatus.Paused, {
    name: 'Paused backup.img',
    progress: 0.68,
  }),
])

const HISTORY_TASKS = Object.freeze([
  makeTask('failed-long', TaskStatus.Error, {
    name: 'Quarterly research archive',
    type: TaskType.Ftp,
    errorMessage:
      'The remote server closed the connection before the response body could be written to disk.',
    errorCode: DownloadErrorCode.NetworkError,
    finishedAt: NOW - 3 * 60_000,
  }),
  makeTask('failed-empty', TaskStatus.Error, {
    name: 'Mirror fallback package',
    type: TaskType.Metalink,
    errorMessage: null,
    finishedAt: NOW - 18 * 60_000,
  }),
  makeTask('completed-large', TaskStatus.Completed, {
    name: 'Full media archive',
    type: TaskType.Bt,
    totalBytes: Number.MAX_SAFE_INTEGER,
    downloadedBytes: Number.MAX_SAFE_INTEGER,
    sizeWhenDone: Number.MAX_SAFE_INTEGER,
    finishedAt: NOW - 45 * 60_000,
  }),
  makeTask('completed-recent', TaskStatus.Completed, {
    name: 'Release notes.pdf',
    finishedAt: NOW - 8 * 60_000,
  }),
])

const LONG_CONTENT_TASKS = Object.freeze([
  makeTask('long-latin', TaskStatus.Downloading, {
    name: `Extremely long downloadable design research collection ${'archive-'.repeat(12)}final.zip`,
  }),
  makeTask('long-cjk', TaskStatus.Downloading, {
    name: '这是一个用于验证仪表板任务名称截断和完整辅助说明的超长中文文件名称'.repeat(
      3
    ),
    type: TaskType.Magnet,
  }),
  makeTask('long-emoji', TaskStatus.Error, {
    name: `Launch assets ${'🚀✨📦'.repeat(24)}.zip`,
    errorMessage: 'A'.repeat(180),
    finishedAt: NOW - 60_000,
  }),
  ...HISTORY_TASKS,
])

function source(
  tasks: readonly DownloadTask[],
  status: TaskListStatus = 'ready',
  hasReadySnapshot = true
): TasksTileDataSource {
  return Object.freeze({
    tasks,
    status,
    hasReadySnapshot,
    retry: NOOP_RETRY,
  })
}

export const TASKS_TILE_FIXTURES: Readonly<
  Record<TasksTileFixtureName, TasksTileFixture>
> = Object.freeze({
  'active-all': Object.freeze({
    engineOnline: true,
    clockNow: NOW,
    source: source(ACTIVE_TASKS),
  }),
  history: Object.freeze({
    engineOnline: true,
    clockNow: NOW,
    source: source(HISTORY_TASKS),
  }),
  loading: Object.freeze({
    engineOnline: true,
    clockNow: NOW,
    source: source(Object.freeze([]), 'loading', false),
  }),
  'initial-error': Object.freeze({
    engineOnline: true,
    clockNow: NOW,
    source: source(Object.freeze([]), 'error', false),
  }),
  'cached-error': Object.freeze({
    engineOnline: true,
    clockNow: NOW,
    source: source(HISTORY_TASKS, 'error', true),
  }),
  empty: Object.freeze({
    engineOnline: true,
    clockNow: NOW,
    source: source(Object.freeze([])),
  }),
  offline: Object.freeze({
    engineOnline: false,
    clockNow: NOW,
    source: source(Object.freeze([...ACTIVE_TASKS, ...HISTORY_TASKS])),
  }),
  'long-content': Object.freeze({
    engineOnline: true,
    clockNow: NOW,
    source: source(LONG_CONTENT_TASKS),
  }),
})

function isFixtureName(value: string): value is TasksTileFixtureName {
  return (TASKS_TILE_FIXTURE_NAMES as readonly string[]).includes(value)
}

export function getTasksTileFixture(
  value: string | null
): TasksTileFixture | null {
  return value && isFixtureName(value) ? TASKS_TILE_FIXTURES[value] : null
}

export function resolveTasksTileFixture(
  value: string | null,
  development: boolean
): TasksTileFixture | null {
  return development ? getTasksTileFixture(value) : null
}
