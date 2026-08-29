import path from 'node:path'
import { newEngineTaskId } from '@core/lib/ids'
import type { AppliedDownloadProxyPolicyReader } from '@core/proxy/applied-download-proxy-policy'
import { AppError, ErrorCode } from '@shared/errors'
import { parseDirectReplayRecipe } from '@shared/schemas/direct-replay-recipe'
import type { EngineTaskOptions } from '@shared/types/engine-task-options'
import type { DownloadTask } from '@shared/types/task'
import { TaskInstancePhase, TaskStatus } from '@shared/types/task'
import {
  canRebuildTaskInputs,
  canReseed,
  canRetry,
  isTorrentLike,
} from '@shared/types/task-actions'
import type {
  CreateDownloadParams,
  DirectResourceMetadataProfile,
  EngineAdapter,
} from '../../engine/engine-adapter'
import type { Logger } from '../../logger'
import { DirectRecoveryPlanner } from '../../session/direct-recovery-planner'
import { applyTerminalTransition } from '../apply-terminal-transition'
import {
  buildFinalOutputFilePaths,
  buildStagingOutputFilePaths,
  getBtStorageLayout,
  parseBtFileLayout,
  shouldPrioritizeBtPreviewPieces,
  shouldPrioritizeBtPreviewPiecesFromMetadata,
} from '../bt-storage-layout'
import {
  canMirrorAria2MetadataHeaders,
  type DirectResourceProxyOptionsProvider,
  DirectResourceValidatorService,
} from '../direct-resource-validator'
import type { TorrentMetaStore } from '../torrent-meta-store'
import { commitTaskUpdate, getTaskOrWarn, type TaskActionDeps } from './shared'

export interface ReAddTaskDeps extends TaskActionDeps {
  runTaskMutation: NonNullable<TaskActionDeps['runTaskMutation']>
  persistTask: NonNullable<TaskActionDeps['persistTask']>
  torrentMetaStore: TorrentMetaStore
  createEngineTaskId?: () => string
  directResourceValidator?: Pick<DirectResourceValidatorService, 'verify'>
  getDirectResourceProxyOptions?: DirectResourceProxyOptionsProvider
  directResourceProxyPolicy?: AppliedDownloadProxyPolicyReader
}

async function bestEffortRemove(
  adapter: EngineAdapter,
  engineTaskId: string,
  log: Logger
): Promise<void> {
  try {
    // forceRemoveTask absorbs an already-evicted gid; any remaining error is
    // non-fatal for a pre-re-add cleanup, so log at debug and continue.
    await adapter.forceRemoveTask(engineTaskId)
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err), engineTaskId },
      'reAddTask: stale gid cleanup skipped'
    )
  }
}

async function compensateFailedReAdd(
  adapter: EngineAdapter,
  engineTaskId: string,
  log: Logger
): Promise<boolean> {
  try {
    await adapter.forceRemoveTask(engineTaskId)
  } catch (err) {
    log.error(
      { err: String(err), engineTaskId },
      'reAddTask: failed to force-remove replacement after add failure'
    )
  }
  try {
    await adapter.removeDownloadResult(engineTaskId)
    // removeDownloadResult success (including the adapter's explicit
    // not-found idempotence) is authoritative absence. forceRemove may have
    // raced a row that was already stopped, so its failure alone must not
    // retain a ghost owner.
    return true
  } catch (err) {
    log.error(
      { err: String(err), engineTaskId },
      'reAddTask: failed to remove replacement result after add failure'
    )
    return false
  }
}

async function readBtMetadata(
  task: DownloadTask,
  deps: ReAddTaskDeps
): Promise<Uint8Array> {
  if (!task.torrentMetaPath) {
    throw new AppError(
      ErrorCode.TaskFinalizeMetaMissing,
      `Torrent metadata missing for task ${task.id}`
    )
  }
  return deps.torrentMetaStore.read(task.torrentMetaPath)
}

/**
 * Where aria2 should write this re-add.
 *
 * A legacy Completed reseed points at `finalPath`: finalize already renamed
 * the temporary output and that is where the seedable content lives
 * (`diskPath` has been normalized to the same value anyway).
 *
 * A retry of a failed or removed download is the opposite case — finalize
 * never ran, so the partial content is still in the in-flight location that
 * `createTaskHandler` passed as `dir` at add time. Pointing
 * `checkIntegrity` at `finalPath` there would scan an empty directory and
 * restart the download from zero.
 */
function reAddSaveDir(task: DownloadTask): string {
  return task.status === TaskStatus.Completed
    ? task.finalPath || task.diskPath
    : task.diskPath || task.finalPath
}

async function reAddBt(
  task: DownloadTask,
  opts: EngineTaskOptions | null,
  deps: ReAddTaskDeps,
  reservedGid: string,
  metadata: Uint8Array
): Promise<string> {
  const storageLayout = getBtStorageLayout(task)
  const parsedLayout = storageLayout ? await parseBtFileLayout(metadata) : null
  const completed = task.status === TaskStatus.Completed
  const prioritizePreviewPieces =
    !completed &&
    (parsedLayout
      ? shouldPrioritizeBtPreviewPieces(parsedLayout)
      : await shouldPrioritizeBtPreviewPiecesFromMetadata(metadata))
  const selectedFiles = task.bt?.selectedFiles
  return deps.adapter.addTorrent({
    metadata,
    saveDir: storageLayout
      ? completed
        ? path.dirname(task.finalPath)
        : storageLayout.workspacePath
      : reAddSaveDir(task),
    outputFilePaths:
      storageLayout && parsedLayout
        ? completed
          ? buildFinalOutputFilePaths(
              parsedLayout,
              task.finalPath,
              storageLayout
            )
          : buildStagingOutputFilePaths(parsedLayout, storageLayout)
        : undefined,
    gid: reservedGid,
    // AddTorrentParams is engine-native; the task aggregate stays 0-based.
    selectedFiles: selectedFiles?.map((index) => index + 1),
    checkIntegrity: true,
    pause: false,
    isPrivate: task.bt?.isPrivate ?? false,
    ...(prioritizePreviewPieces ? { prioritizePreviewPieces: true } : {}),
    seedTime: opts?.['seed-time']
      ? Number.parseInt(opts['seed-time'], 10)
      : undefined,
    seedRatio: opts?.['seed-ratio']
      ? Number.parseFloat(opts['seed-ratio'])
      : undefined,
  })
}

const directRecoveryPlanner = new DirectRecoveryPlanner()
const directResourceValidator = new DirectResourceValidatorService()

async function buildDirectReAddParams(
  task: DownloadTask,
  adapter: EngineAdapter,
  resourceValidator: Pick<DirectResourceValidatorService, 'verify'>,
  getProxyOptions: DirectResourceProxyOptionsProvider,
  assertProxyCurrent: (() => void) | undefined,
  metadataHeadersSupported: boolean
): Promise<Omit<CreateDownloadParams, 'gid'>> {
  const primary = task.instances.find(
    (instance) => instance.phase === TaskInstancePhase.HttpDownload
  )
  const recipe = parseDirectReplayRecipe(primary?.payload)
  if (!primary || !recipe || recipe.replayability !== 'uri-only') {
    throw new AppError(
      ErrorCode.TaskNotRetryable,
      `Task ${task.id} cannot be retried: its direct replay recipe is unavailable`
    )
  }
  const requestOptions = getProxyOptions()

  const plan = await directRecoveryPlanner.plan({
    primary,
    finalPath: task.finalPath,
  })
  if (
    plan.kind === 'blocked' ||
    plan.kind === 'invalid' ||
    plan.kind === 'finalization-candidate' ||
    !plan.saveDir ||
    !plan.filename
  ) {
    throw new AppError(
      ErrorCode.TaskNotRetryable,
      `Task ${task.id} cannot be retried safely: ${plan.reason}`
    )
  }

  let ifRange: string | null = null
  const metadataProfile = metadataHeadersSupported
    ? resolveDirectResourceMetadataProfile(adapter)
    : null
  if (plan.kind === 'checkpoint' && metadataProfile === null) {
    throw new AppError(
      ErrorCode.TaskNotRetryable,
      `Task ${task.id} cannot be retried safely: metadata-request-profile-unsupported`
    )
  }
  if (plan.kind === 'checkpoint' && !recipe.resourceValidator) {
    throw new AppError(
      ErrorCode.TaskNotRetryable,
      `Task ${task.id} cannot be retried safely: resource-validator-unavailable`
    )
  }
  if (plan.kind === 'checkpoint' && recipe.resourceValidator) {
    if (primary.uris.length !== 1) {
      throw new AppError(
        ErrorCode.TaskNotRetryable,
        `Task ${task.id} cannot be retried safely: ambiguous-validator-source`
      )
    }
    if (requestOptions === null) {
      throw new AppError(
        ErrorCode.TaskNotRetryable,
        `Task ${task.id} cannot be retried safely: proxy-policy-unavailable`
      )
    }
    if (!metadataHeadersSupported) {
      throw new AppError(
        ErrorCode.TaskNotRetryable,
        `Task ${task.id} cannot be retried safely: metadata-header-profile-unsupported`
      )
    }
    const validation = await resourceValidator.verify(
      primary.uris[0] as string,
      recipe.resourceValidator,
      requestOptions
    )
    assertProxyCurrent?.()
    if (validation.outcome !== 'unchanged') {
      throw new AppError(
        ErrorCode.TaskNotRetryable,
        `Task ${task.id} cannot be retried safely: ${validation.outcome}`
      )
    }
    ifRange = validation.ifRange
  }

  return {
    uris: primary.uris,
    saveDir: plan.saveDir,
    filename: plan.filename,
    connections: recipe.connections,
    ...(plan.kind !== 'checkpoint' || metadataProfile === null
      ? {}
      : { directResourceMetadataProfile: metadataProfile }),
    ...(requestOptions?.userAgent === undefined
      ? {}
      : { userAgent: requestOptions.userAgent }),
    ...(ifRange ? { headers: { 'If-Range': ifRange } } : {}),
    pause: false,
    resumePolicy:
      plan.kind === 'checkpoint'
        ? 'checkpoint'
        : plan.reason === 'temp-file-empty'
          ? 'sequential-prefix'
          : 'none',
  }
}

function resolveDirectResourceMetadataProfile(
  adapter: EngineAdapter
): DirectResourceMetadataProfile | null {
  if (!adapter.getDirectResourceMetadataProfile) return null
  try {
    return adapter.getDirectResourceMetadataProfile()
  } catch {
    return null
  }
}

/**
 * Rebuild the task with a new reserved engine gid stamped on the aggregate
 * and its primary instance (the one whose gid matches the outgoing
 * `engineTaskId`). With `status` the builder also applies the status
 * transition — that variant is the published re-add candidate; without it,
 * only the identity changes — the silent reserved owner installed before
 * engine dispatch.
 */
function withReservedGid(
  task: DownloadTask,
  engineTaskId: string,
  now: number,
  status?: TaskStatus
): DownloadTask {
  const primaryIndex = Math.max(
    0,
    task.instances.findIndex((instance) => instance.gid === task.engineTaskId)
  )
  return {
    ...task,
    engineTaskId,
    ...(status ? applyTerminalTransition(task, status, {}, now) : {}),
    instances: task.instances.map((instance, index) =>
      index === primaryIndex
        ? {
            ...instance,
            gid: engineTaskId,
            ...(status ? { status } : {}),
            updatedAt: now,
          }
        : instance
    ),
    updatedAt: now,
  }
}

/**
 * Claim the already-durable candidate in memory without another persistence
 * attempt. The pre-dispatch candidate is already on disk, so a failure of
 * this refresh must not leave the silent reservation owner shielding a
 * possibly-live GID forever — even the claim failure is only logged.
 */
async function claimOwnerWithoutPersist(
  reservedOwner: DownloadTask,
  candidate: DownloadTask,
  deps: ReAddTaskDeps,
  failureMessage: string
): Promise<void> {
  try {
    await commitTaskUpdate(reservedOwner, candidate, deps, {
      accuracy: 'recovered',
      persist: async () => undefined,
    })
  } catch (publicationError) {
    deps.log.error(
      {
        error: String(publicationError),
        taskId: candidate.id,
        engineTaskId: candidate.engineTaskId,
      },
      failureMessage
    )
  }
}

async function publishReservedOwner(
  reservedOwner: DownloadTask,
  candidate: DownloadTask,
  deps: ReAddTaskDeps
): Promise<void> {
  try {
    await commitTaskUpdate(reservedOwner, candidate, deps, {
      accuracy: 'recovered',
    })
  } catch (error) {
    deps.log.error(
      { error: String(error), taskId: candidate.id },
      'reAddTask: failed to publish retained replacement owner'
    )
    await claimOwnerWithoutPersist(
      reservedOwner,
      candidate,
      deps,
      'reAddTask: failed to claim retained replacement owner'
    )
  }
}

async function handleFailedEngineAdd(
  error: unknown,
  previous: DownloadTask,
  reservedOwner: DownloadTask,
  candidate: DownloadTask,
  reservedGid: string,
  deps: ReAddTaskDeps
): Promise<never> {
  const cleanupComplete = await compensateFailedReAdd(
    deps.adapter,
    reservedGid,
    deps.log
  )
  if (cleanupComplete) {
    // Restore the previous owner synchronously. Removing the reserved GID from
    // the indexed owner retires it; the explicit conversion then clears the
    // still-live reservation while preserving that stale-snapshot shield.
    deps.taskManager.set(previous.id, previous)
    deps.taskManager.retireEngineTaskIdReservation(reservedGid)
    try {
      await deps.persistTask(previous)
    } catch (rollbackError) {
      // The durable candidate still owns the reserved GID. The retired shield
      // blocks a late in-process snapshot, and restart can recover the same
      // public task identity from the candidate's instance GID.
      deps.log.error(
        {
          error: String(rollbackError),
          taskId: previous.id,
          engineTaskId: reservedGid,
        },
        'reAddTask: failed to roll back durable replacement reservation'
      )
    }
  } else {
    // The add outcome is unknown and cleanup did not prove the GID absent.
    // Claim the already-durable candidate in memory before returning the
    // original error so polling cannot mint a duplicate public task.
    await publishReservedOwner(reservedOwner, candidate, deps)
  }
  throw error
}

/**
 * Re-add a task to the engine — used for both Retry (Error/Removed)
 * and Re-seed (Completed BT). Pulls live options from aria2 if the
 * stopped-result is still resident (Tier 1) and falls back to
 * task-record fields when not (Tier 2).
 *
 * No `terminalCause` is threaded through this file's `commitTaskUpdate`
 * calls: every candidate this function ever publishes lands in `Seeding` or
 * `Downloading` (see `createReAddCandidate`/`createReservedEngineOwner`) —
 * this action always transitions AWAY FROM a terminal status, never into
 * one, so `buildTerminalOccurrence` is guaranteed to return `null` here
 * regardless of which cause were passed.
 */
export async function reAddTask(
  taskId: string,
  deps: ReAddTaskDeps
): Promise<void> {
  const run = (
    getProxyOptions: DirectResourceProxyOptionsProvider,
    assertProxyCurrent?: () => void
  ) => {
    const reAdd = (): Promise<void> =>
      reAddTaskUnderMutation(taskId, deps, getProxyOptions, assertProxyCurrent)
    return deps.runTaskMutation([taskId], reAdd)
  }
  if (deps.directResourceProxyPolicy) {
    await deps.directResourceProxyPolicy.runWithSnapshot((snapshot, lease) => {
      const providerOptions = deps.getDirectResourceProxyOptions?.()
      const requestOptions = snapshot
        ? {
            ...snapshot,
            ...(providerOptions?.userAgent === undefined
              ? {}
              : { userAgent: providerOptions.userAgent }),
          }
        : null
      return run(() => requestOptions, lease.assertCurrent)
    })
    return
  }
  await run(deps.getDirectResourceProxyOptions ?? (() => null))
}

/**
 * Own the public task ID before reading its current engine GID and retain that
 * ownership until the replacement is durable and published. Otherwise remove
 * can delete the parent while addTorrent/createDownload is in flight, and a
 * stale commit rejection has no owner through which to clean up the fresh GID.
 */
async function reAddTaskUnderMutation(
  taskId: string,
  deps: ReAddTaskDeps,
  getProxyOptions: DirectResourceProxyOptionsProvider,
  assertProxyCurrent?: () => void
): Promise<void> {
  const task = getTaskOrWarn(deps, taskId, 'reAddTask')
  if (!task) return
  if (canRetry(task)) {
    // Retry additionally requires the engine dispatch to be reconstructable
    // from the task record (canReseed already implies this for its own path,
    // since it requires torrentMetaPath itself) — reject up front rather than
    // discovering mid-flow (e.g. a media task with no single re-addable
    // handle, or a torrent-like task with no persisted sidecar).
    if (!canRebuildTaskInputs(task)) {
      deps.log.warn(
        { taskId, status: task.status, type: task.type, kind: task.kind },
        'reAddTask: task inputs cannot be rebuilt'
      )
      throw new AppError(
        ErrorCode.TaskNotRetryable,
        `Task ${taskId} cannot be retried: required inputs are unavailable`
      )
    }
  } else if (!canReseed(task)) {
    deps.log.warn(
      { taskId, status: task.status, type: task.type },
      'reAddTask: task is not in a re-addable state'
    )
    return
  }
  // Resolve local prerequisites before touching the old engine GID or
  // installing a durable reservation. From the reservation onward, the only
  // fallible operation before publication is the engine dispatch itself.
  const torrentLike = isTorrentLike(task)
  const torrentMetadata = torrentLike ? await readBtMetadata(task, deps) : null
  const directParams = torrentLike
    ? null
    : await buildDirectReAddParams(
        task,
        deps.adapter,
        deps.directResourceValidator ?? directResourceValidator,
        getProxyOptions,
        assertProxyCurrent,
        canMirrorAria2MetadataHeaders(deps.adapter.getFeatureReport?.())
      )
  let opts: EngineTaskOptions | null = null
  try {
    opts = await deps.adapter.getEngineTaskOptions(task.engineTaskId)
  } catch (err) {
    deps.log.debug(
      { err: String(err), taskId },
      'reAddTask: getEngineTaskOptions failed; falling back to task fields'
    )
  }
  await bestEffortRemove(deps.adapter, task.engineTaskId, deps.log)

  const now = Date.now()
  const status = torrentLike ? TaskStatus.Seeding : TaskStatus.Downloading
  const reservedGid = newEngineTaskId(deps.createEngineTaskId, 'reAddTask')
  const reservedOwner = withReservedGid(task, reservedGid, now)
  const candidate = withReservedGid(task, reservedGid, now, status)

  deps.taskManager.reserveEngineTaskId(reservedGid)
  try {
    // Durable intent precedes the engine side effect. The candidate's primary
    // instance carries reservedGid, so restart owns a row accepted immediately
    // before a crash or lost RPC response.
    await deps.persistTask(candidate)
  } catch (error) {
    // No engine call has happened; releasing the process-local shield is safe.
    deps.taskManager.releaseEngineTaskIdReservation(reservedGid)
    throw error
  }
  // No await is allowed between the durable barrier and this silent owner
  // install. It keeps Session auto-save on the reserved GID and gives engine
  // notifications an owner, while the retained reservation still makes the
  // authoritative poll skip reconciliation until success/failure is known.
  deps.taskManager.setReservedEngineTaskOwner(
    task.id,
    reservedOwner,
    reservedGid
  )

  try {
    if (torrentLike && torrentMetadata) {
      await reAddBt(task, opts, deps, reservedGid, torrentMetadata)
    } else if (directParams) {
      assertProxyCurrent?.()
      await deps.adapter.createDownload({ ...directParams, gid: reservedGid })
    }
  } catch (error) {
    await handleFailedEngineAdd(
      error,
      task,
      reservedOwner,
      candidate,
      reservedGid,
      deps
    )
  }

  // Persist once more after the engine accepts: an auto-save queued behind the
  // pre-add barrier may have written reservedOwner's previous status. The
  // canonical commit then claims the reservation and emits the exact status
  // transition with no ownerless interval.
  try {
    await commitTaskUpdate(reservedOwner, candidate, deps)
  } catch (error) {
    // The pre-add candidate is already durable and the engine accepted its
    // caller-reserved GID. A failure of this defensive second write must not
    // leave the silent owner + reservation shielding that live GID forever.
    // Publish without another persistence attempt, then surface the original
    // durability error so the caller still sees degraded storage.
    deps.log.error(
      { error: String(error), taskId, engineTaskId: reservedGid },
      'reAddTask: post-add persistence refresh failed; publishing durable owner'
    )
    await claimOwnerWithoutPersist(
      reservedOwner,
      candidate,
      deps,
      'reAddTask: failed to publish accepted replacement owner'
    )
    throw error
  }
}
