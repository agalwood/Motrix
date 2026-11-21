import type { EngineAdapter } from '@core/engine/engine-adapter'
import { hasLegacyImport } from '@core/legacy-import/legacy-task-policy'
import { computeUriHash } from '@core/session/content-key'
import { AppError, ErrorCode } from '@shared/errors'
import {
  type TaskSourceKind,
  type TaskSourcesSnapshot,
  taskSourcesRequestSchema,
  taskSourcesUpdateSchema,
  taskSourceUrlsSchema,
} from '@shared/schemas/task-sources'
import {
  type DownloadTask,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import type { TaskManager } from './task-manager'
import { taskWebSeeds } from './task-source-state'

interface Deps {
  taskManager: Pick<TaskManager, 'getById' | 'set'>
  engine: Pick<EngineAdapter, 'getTaskSources' | 'replaceTaskSources'>
  runTaskMutation?: <T>(
    ids: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
  authorizeTaskWrite?: (task: DownloadTask) => Promise<void>
  persistTask?: (task: DownloadTask) => Promise<unknown>
  publishTaskUpdate?: () => void
}

function ownedTask(deps: Deps, taskId: string, engineTaskId: string) {
  const task = deps.taskManager.getById(taskId)
  if (!task)
    throw new AppError(ErrorCode.TaskNotFound, 'task.sources.unavailable')
  if (task.engineTaskId !== engineTaskId)
    throw new AppError(ErrorCode.InvalidSelection, 'task.sources.changed')
  return task
}

function kindOf(task: DownloadTask): TaskSourceKind {
  if (task.kind === TaskKind.Bt) return 'webseed'
  if (task.kind === TaskKind.Direct && task.type === TaskType.Http)
    return 'http'
  if (task.kind === TaskKind.Direct && task.type === TaskType.Ftp) return 'ftp'
  throw new AppError(
    ErrorCode.EngineFeatureUnavailable,
    'task.sources.unavailable'
  )
}

function editable(task: DownloadTask, engine: Deps['engine']): boolean {
  return (
    Boolean(engine.getTaskSources && engine.replaceTaskSources) &&
    (task.kind !== TaskKind.Bt || task.type === TaskType.Bt) &&
    !hasLegacyImport(task) &&
    !task.storageOperation &&
    task.transitionPhase === TransitionPhase.Idle &&
    [
      TaskStatus.Queued,
      TaskStatus.Downloading,
      TaskStatus.Paused,
      TaskStatus.Seeding,
    ].includes(task.status)
  )
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((uri, i) => uri === b[i])

export function createTaskSourcesHandlers(deps: Deps) {
  async function get(raw: unknown): Promise<TaskSourcesSnapshot> {
    const { taskId, engineTaskId } = taskSourcesRequestSchema.parse(raw)
    const task = ownedTask(deps, taskId, engineTaskId)
    const kind = kindOf(task)
    const canEdit = editable(task, deps.engine)
    const read = deps.engine.getTaskSources?.bind(deps.engine)
    const uris =
      canEdit && read
        ? await read(engineTaskId)
        : kind === 'webseed'
          ? (taskWebSeeds(task) ?? [])
          : task.uris
    ownedTask(deps, taskId, engineTaskId)
    return { taskId, engineTaskId, kind, uris, editable: canEdit }
  }

  async function update(raw: unknown): Promise<TaskSourcesSnapshot> {
    const request = taskSourcesUpdateSchema.parse(raw)
    const run = deps.runTaskMutation?.bind(deps)
    const persist = deps.persistTask?.bind(deps)
    const read = deps.engine.getTaskSources?.bind(deps.engine)
    const replace = deps.engine.replaceTaskSources?.bind(deps.engine)
    if (!run || !persist || !read || !replace)
      throw new AppError(
        ErrorCode.EngineFeatureUnavailable,
        'task.sources.unavailable'
      )
    return run([request.taskId], async () => {
      const task = ownedTask(deps, request.taskId, request.engineTaskId)
      const kind = kindOf(task)
      if (!editable(task, deps.engine))
        throw new AppError(
          ErrorCode.InvalidSelection,
          'task.sources.unavailable'
        )
      await deps.authorizeTaskWrite?.(task)
      const parsed = taskSourceUrlsSchema(kind).safeParse(request.uris)
      if (!parsed.success)
        throw new AppError(ErrorCode.TaskSourceInvalid, 'task.sources.invalid')
      const before = await read(task.engineTaskId)
      const owner = ownedTask(deps, task.id, task.engineTaskId)
      if (!editable(owner, deps.engine))
        throw new AppError(
          ErrorCode.InvalidSelection,
          'task.sources.unavailable'
        )
      if (!same(before, request.previous))
        throw new AppError(ErrorCode.InvalidSelection, 'task.sources.changed')
      const uris = parsed.data
      if (!same(before, uris)) await replace(task.engineTaskId, before, uris)
      // Engine acknowledgement is authoritative. Do not roll the UI back to old
      // sources if the host database fails; periodic persistence can retry it.
      const latest = ownedTask(deps, task.id, task.engineTaskId)
      const updated: DownloadTask = {
        ...latest,
        ...(kind === 'webseed'
          ? { bt: latest.bt ? { ...latest.bt, webSeeds: uris } : undefined }
          : { uris }),
        instances: latest.instances.map((instance) =>
          instance.gid === task.engineTaskId
            ? {
                ...instance,
                ...(kind === 'webseed'
                  ? { payload: { ...instance.payload, webSeeds: uris } }
                  : { uris, uriHash: computeUriHash(uris) }),
              }
            : instance
        ),
      }
      deps.taskManager.set(task.id, updated)
      try {
        await persist(updated)
      } finally {
        deps.publishTaskUpdate?.()
      }
      return {
        taskId: task.id,
        engineTaskId: task.engineTaskId,
        kind,
        uris,
        editable: true,
      }
    })
  }
  return { get, update }
}
