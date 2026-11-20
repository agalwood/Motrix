import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { journalHandoffModule } from '@core/bridge/journal-handoff-module'
import type { MdxpSessionContext } from '@core/bridge/mdxp-session-context'
import { createDownloadDirectories } from '@core/bridge-receiver/download-directories'
import { directTaskRequest } from '@core/bridge-receiver/pipelines/direct-pipeline'
import { SubmitDownloadAdapter } from '@core/bridge-receiver/submit-download-adapter'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { getLogger } from '@core/logger'
import type {
  DownloadHandoffJournal,
  HandoffStatus,
} from '@core/session/download-handoff-journal'
import type { MotrixDatabase } from '@core/session/motrix-database'
import type { SessionManager } from '@core/session/session-manager'
import {
  type CreateTaskDeps,
  handleCreateTask,
} from '@core/task/create-task-handler'
import { admitTaskCookies } from '@core/task/task-cookie-admission'
import { taskRowToDownloadTask } from '@core/task/task-row-to-download-task'
import {
  DownloadHandoffPayloadSchema,
  type DownloadSubmitParams,
  ErrorCodes,
  makeMdxpError,
} from '@motrix/mdxp'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
} from '@shared/types/task'

const log = getLogger('desktop-download-handoff')

export async function activateDesktopHandoff(
  journal: DownloadHandoffJournal,
  db: MotrixDatabase,
  engine: EngineAdapter,
  taskId: string,
  resolveDirectory: (dir: string) => Promise<string>
) {
  return journal.activate(taskId, {
    contains: async (gid) => {
      const live = await engine.getTaskStatus(gid)
      if (live === null) return false
      const row = db.getTask(taskId)
      const instance = row?.instances[0]
      if (
        !instance ||
        instance.gid !== gid ||
        live.diskPath !== instance.diskPath ||
        !live.uris.some((uri) => instance.uris.includes(uri))
      )
        throw new Error('Engine task does not match the handoff reservation')
      return true
    },
    beforeStart: async (intent) => {
      const request = intent.engineRequest
      const row = db.getTask(taskId)
      if (
        !request ||
        !row ||
        row.task.kind !== TaskKind.Direct ||
        row.task.taskType !== TaskType.Http ||
        row.task.aggStatus !== TaskStatus.Queued ||
        row.instances.length !== 1 ||
        row.instances[0]?.gid !== intent.engineId ||
        row.instances[0]?.status !== TaskStatus.Queued ||
        row.instances[0]?.phase !== TaskInstancePhase.HttpDownload ||
        request.gid !== intent.engineId ||
        request.saveDir !== intent.saveDir ||
        !request.filename ||
        path.basename(request.filename) !== request.filename ||
        path.join(intent.saveDir, request.filename) !==
          row.instances[0]?.diskPath ||
        (await resolveDirectory(intent.saveDir)) !== intent.saveDir
      )
        throw new Error('Invalid desktop handoff activation')
      // A pending intent has never been dispatched. Files appearing here
      // after commit may belong to another application, including symlinks.
      for (const file of [
        row.task.finalPath,
        row.instances[0].diskPath,
        row.instances[0].diskPath + '.aria2',
      ]) {
        const occupied = await lstat(file).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false
            throw error
          }
        )
        if (occupied) throw new Error('Handoff output is already occupied')
      }
    },
    start: async ({ engineRequest }) => {
      if (!engineRequest) throw new Error('Missing desktop handoff request')
      return engine.createDownload(engineRequest)
    },
  })
}

export function desktopDownloadHandoff(
  journal: DownloadHandoffJournal,
  db: MotrixDatabase,
  session: SessionManager,
  deps: CreateTaskDeps
) {
  const settings = () => deps.settingsManager.getApp()
  const directories = createDownloadDirectories({ getSettings: settings })
  const directoryPolicy = () =>
    JSON.stringify([settings().defaultSaveDir, settings().directoryPreferences])
  const resolveDirectory = directories.resolveSelection
  async function adapt(
    download: DownloadSubmitParams,
    ctx: MdxpSessionContext,
    taskId: string
  ) {
    if (ctx.identity.kind !== 'extension' || !ctx.sessionKey)
      throw makeMdxpError(
        ErrorCodes.PermissionDenied,
        'Paired extension required'
      )
    const normalizer = new SubmitDownloadAdapter({
      getDefaultSaveDir: () => settings().defaultSaveDir,
      resolveSaveDir: resolveDirectory,
      // The shared task creator picks the collision-safe name under its directory lock.
      pickName: async (_dir, name) => name,
      mintTaskId: () => taskId,
    })
    const direct = await normalizer.adapt(download, {
      ...ctx.identity,
      sessionKey: ctx.sessionKey,
    })
    if (direct.kind !== 'direct')
      throw makeMdxpError(ErrorCodes.InvalidParams, 'Direct download required')
    return direct
  }

  return journalHandoffModule(journal, {
    ttlMs: 120_000,
    directory: async (download, ctx) => {
      await deps.waitForEngineReady?.()
      const direct = await adapt(download, ctx, '')
      admitTaskCookies(deps.adapter, direct.cookies)
      return resolveDirectory(direct.saveDir)
    },
    commit: (key, hash, ctx) =>
      journal.withPrepared(key, hash, async (intent) => {
        const download = DownloadHandoffPayloadSchema.parse(
          JSON.parse(intent.canonicalPayload)
        )
        const direct = await adapt(
          { ...download, saveDir: intent.saveDir },
          ctx,
          intent.taskId
        )
        let reply: HandoffStatus | undefined
        await handleCreateTask(directTaskRequest(direct), deps, {
          source: 'bridge',
          sourceMeta: direct.sourceMeta,
          cookies: direct.cookies,
          handoff: {
            taskId: intent.taskId,
            gid: intent.engineId,
            commit: (task, launch) =>
              session.runExclusivePersistence(async () => {
                const policy = directoryPolicy()
                await resolveDirectory(intent.saveDir)
                const snapshot = await session.buildTaskPayload(
                  task,
                  task.createdAt
                )
                reply = await journal.commit(
                  key,
                  hash,
                  () => {
                    if (
                      !ctx.isAuthorized() ||
                      !ctx.isReady() ||
                      policy !== directoryPolicy()
                    )
                      throw makeMdxpError(
                        ErrorCodes.PermissionDenied,
                        'Handoff authorization changed'
                      )
                    return snapshot
                  },
                  launch
                )
                if (
                  reply.state === 'committed' &&
                  !deps.taskManager.getById(task.id)
                ) {
                  const recorded = db.getTask(task.id)
                  if (recorded) {
                    deps.taskManager.reserveEngineTaskId(intent.engineId)
                    deps.taskManager.setReservedEngineTaskOwner(
                      task.id,
                      taskRowToDownloadTask(recorded.task, recorded.instances),
                      intent.engineId
                    )
                    deps.activityRecorder.recordSubmitted({
                      taskId: task.id,
                      occurredAt: recorded.task.createdAt,
                    })
                    deps.publishTaskUpdate()
                  }
                }
              }),
          },
        })
        if (!reply) throw new Error('Handoff was not recorded')
        return reply
      }),
    committed: async (taskId) => {
      try {
        await deps.waitForEngineReady?.()
        const activate = () =>
          activateDesktopHandoff(
            journal,
            db,
            deps.adapter,
            taskId,
            resolveDirectory
          )
        const result = await deps.directResourceProxyPolicy.runWithSnapshot(
          (_snapshot, lease) => {
            lease.assertCurrent()
            return deps.runTaskMutation
              ? deps.runTaskMutation([taskId], activate)
              : activate()
          }
        )
        if (result === 'activated') {
          const owner = deps.taskManager.getById(taskId)
          if (owner) deps.taskManager.set(taskId, owner)
        }
      } catch {
        // The receipt already owns the task. A lost engine reply must not cause
        // a legacy submit or deletion of the activation that startup reconciles.
        log.warn({ taskId }, 'committed download awaits engine reconciliation')
      }
    },
  })
}
