import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { sanitizeFinalizeFilename } from '@core/fs/finalize-path'
import type { DurableFinalizeRuntime } from '@core/session/durable-finalize-runtime'
import { DownloadErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import {
  type BtStorageCommandResult,
  type BtStorageFailureReason,
  type BtStorageProgress,
  type BtStorageRequest,
  type BtStorageResult,
  type BtVerificationResult,
  btStorageRequestSchema,
} from '@shared/schemas/bt-storage'
import {
  type DownloadTask,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'
import { canManageBtStorage } from '@shared/types/task-actions'
import type { ReAddTaskDeps } from './actions/re-add-task'
import { reAddTask } from './actions/re-add-task'
import {
  acquireBtInfoHashAdmission,
  normalizeBtInfoHash,
  withBtOutputAdmissions,
} from './bt-duplicate-policy'
import { verifyBtFiles } from './bt-file-verifier'
import {
  btOutputPaths,
  hasBtControlFile,
  hasReservedTaskOutput,
} from './bt-output-reservation'
import { btStoragePayload, parseBtFileLayout } from './bt-storage-layout'
import { settleBtUpload } from './bt-upload-settlement'
import { outputPathIdentity } from './output-path-identity'
import {
  collectTaskGids,
  pickPrimaryInstance,
  syncTerminalInstanceStatus,
} from './task-instance'

export interface BtStorageServiceDeps extends ReAddTaskDeps {
  runtime: Pick<
    DurableFinalizeRuntime,
    'commit' | 'withArtifactLease' | 'hasPendingFinalization'
  >
  /** Both roots and task-file cache rebasing share the same database transaction. */
  persistStorage(
    task: DownloadTask,
    sourceRoot: string,
    targetRoot: string
  ): Promise<void>
  authorizeDirectory(directory: string): Promise<string>
  verify?: typeof verifyBtFiles
}

class StorageFault extends Error {
  constructor(readonly reason: BtStorageFailureReason) {
    super(reason)
  }
}
class IncompleteFiles extends Error {
  constructor(readonly verification: BtVerificationResult) {
    super('incomplete')
  }
}

function overlaps(a: string, b: string): boolean {
  const relative = path.relative(a, b)
  return (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

/** Owns one quiesced BT task from verification through durable relocation. */
export class BtStorageService {
  private readonly running = new Map<
    string,
    { controller: AbortController; cancellable: boolean }
  >()
  constructor(private readonly deps: BtStorageServiceDeps) {}

  cancel(taskId: string): void {
    const running = this.running.get(taskId)
    if (running?.cancellable) running.controller.abort()
  }

  async run(
    raw: BtStorageRequest,
    admissionHeld = false
  ): Promise<BtStorageCommandResult> {
    const parsed = btStorageRequestSchema.safeParse(raw)
    if (!parsed.success) return { error: 'destination' }
    const request = parsed.data
    if (this.running.has(request.taskId)) return { error: 'busy' }
    const running = { controller: new AbortController(), cancellable: true }
    this.running.set(request.taskId, running)
    try {
      const task = this.deps.taskManager.getById(request.taskId)
      if (!task || !canManageBtStorage(task) || !task.infoHash)
        throw new StorageFault('unavailable')
      const directory = await this.deps.authorizeDirectory(
        request.mode === 'recheck'
          ? path.dirname(task.finalPath)
          : (request.directory ?? '')
      )
      const execute = () =>
        this.deps.runTaskMutation([task.id], () =>
          this.execute(request, directory, running, task.finalPath)
        )
      if (admissionHeld) return await execute()
      const release = await acquireBtInfoHashAdmission(task.infoHash)
      try {
        return await withBtOutputAdmissions(
          request.mode === 'move'
            ? [directory, path.dirname(task.finalPath)]
            : [directory],
          execute
        )
      } finally {
        release()
      }
    } catch (error) {
      if (running.controller.signal.aborted) return { error: 'cancelled' }
      this.deps.log.warn(
        { taskId: request.taskId, error },
        'BT storage operation failed'
      )
      return { error: error instanceof StorageFault ? error.reason : 'failed' }
    } finally {
      const current = this.deps.taskManager.getById(request.taskId)
      if (current?.storageOperation) {
        const settled = { ...current }
        delete settled.storageOperation
        this.deps.taskManager.set(settled.id, settled)
        this.deps.publishTaskUpdateNow()
      }
      this.running.delete(request.taskId)
    }
  }

  private async execute(
    request: ReturnType<typeof btStorageRequestSchema.parse>,
    directory: string,
    running: { controller: AbortController; cancellable: boolean },
    expectedPath: string
  ): Promise<BtStorageResult> {
    const deps = this.deps
    const original = deps.taskManager.getById(request.taskId)
    if (!original || !canManageBtStorage(original) || !original.torrentMetaPath)
      throw new StorageFault('unavailable')
    if (await deps.runtime.hasPendingFinalization(original.id))
      throw new StorageFault('busy')
    if (original.finalPath !== expectedPath)
      throw new StorageFault('unavailable')
    if ((await deps.authorizeDirectory(directory)) !== directory)
      throw new StorageFault('destination')
    const metadata = await deps.torrentMetaStore.read(original.torrentMetaPath)
    const layout = await parseBtFileLayout(metadata)
    if (layout.infoHash !== normalizeBtInfoHash(original.infoHash ?? ''))
      throw new StorageFault('unavailable')
    const sourcePath = original.finalPath || original.diskPath
    if (
      !sourcePath ||
      outputPathIdentity(sourcePath) ===
        outputPathIdentity(path.parse(sourcePath).root)
    )
      throw new StorageFault('destination')
    // Authorize the old root too: Server must not move/read outside its current policy.
    const source =
      request.mode === 'locate'
        ? sourcePath
        : path.join(
            await deps.authorizeDirectory(path.dirname(sourcePath)),
            path.basename(sourcePath)
          )
    const name =
      request.mode === 'recheck' ? path.basename(source) : (request.name ?? '')
    if (
      !name ||
      name !== sanitizeFinalizeFilename(name) ||
      name === '.' ||
      name === '..'
    )
      throw new StorageFault('destination')
    const target = path.join(directory, name)
    const sourceIdentity = outputPathIdentity(source)
    const targetIdentity = outputPathIdentity(target)
    if (
      request.mode !== 'recheck' &&
      sourceIdentity !== targetIdentity &&
      (overlaps(sourceIdentity, targetIdentity) ||
        overlaps(targetIdentity, sourceIdentity))
    )
      throw new StorageFault('destination')
    if (request.mode === 'move' && sourceIdentity === targetIdentity)
      throw new StorageFault('destination')
    if (
      hasReservedTaskOutput(
        deps.taskManager.getAll(),
        (request.mode === 'move' ? [source, target] : [target]).flatMap(
          (output) => btOutputPaths(output, layout.multiFile)
        ),
        original.id
      )
    )
      throw new StorageFault('conflict')
    if (
      !layout.multiFile &&
      outputPathIdentity(`${sourcePath}.aria2`) !==
        outputPathIdentity(`${target}.aria2`) &&
      (await hasBtControlFile(target))
    )
      throw new StorageFault('destination')
    if (request.mode === 'move') {
      const occupied = await lstat(target).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return null
      })
      if (occupied) throw new StorageFault('destination')
    }
    const active = await deps.adapter.listActiveAndWaiting()
    const gids = collectTaskGids(original)
    if (
      active.some(
        (entry) =>
          entry.infoHash?.toLowerCase() === layout.infoHash &&
          !gids.has(entry.gid)
      )
    )
      throw new StorageFault('conflict')
    if (!pickPrimaryInstance(original.instances))
      throw new StorageFault('unavailable')
    running.controller.signal.throwIfAborted()
    deps.taskManager.set(original.id, { ...original, storageOperation: true })
    deps.publishTaskUpdateNow()
    let upload = 0
    try {
      upload = await deps.adapter.getUploadLength(original.engineTaskId)
    } catch {
      /* Retain observed total. */
    }
    // Completion alone is not proof that aria2 released its handles.
    try {
      for (const gid of gids) {
        try {
          await deps.adapter.forceRemoveTask(gid)
        } catch (error) {
          // aria2 rejects forceRemove on an already-stopped result. Result
          // cleanup and the live-owner check below are the absence proof.
          deps.log.debug(
            { gid, error },
            'BT storage stop request was not accepted'
          )
        }
        await deps.adapter.removeDownloadResult(gid)
      }
      if (
        (await deps.adapter.listActiveAndWaiting()).some((entry) =>
          gids.has(entry.gid)
        )
      )
        throw new StorageFault('engine')
    } catch {
      throw new StorageFault('engine')
    }

    const stopped = structuredClone(original)
    stopped.storageOperation = true
    settleBtUpload(stopped, upload, false)
    stopped.downloadSpeed = 0
    stopped.uploadSpeed = 0
    if (
      stopped.status === TaskStatus.Seeding ||
      stopped.status === TaskStatus.Paused
    ) {
      stopped.status = TaskStatus.Completed
      syncTerminalInstanceStatus(stopped, TaskStatus.Completed)
    }
    // Do not emit another download completion or trigger completion plugins.
    await deps.persistStorage(stopped, sourcePath, sourcePath)
    deps.publishTaskUpdateNow()

    const progress = (
      phase: BtStorageProgress['phase'],
      checkedPieces = 0,
      totalPieces = 0
    ) =>
      deps.eventBus.emit(Events.BtStorageProgress, {
        taskId: stopped.id,
        phase,
        checkedPieces,
        totalPieces,
      } satisfies BtStorageProgress)
    const verify = async (payloadPath: string) => {
      progress('checking')
      if (
        (await deps.authorizeDirectory(path.dirname(payloadPath))) !==
        path.dirname(payloadPath)
      )
        throw new StorageFault('destination')
      const result = await (deps.verify ?? verifyBtFiles)({
        metadata,
        payloadPath,
        selectedFiles: stopped.bt?.selectedFiles,
        signal: running.controller.signal,
        onProgress: (checked, total) => progress('checking', checked, total),
      })
      if (
        (await deps.authorizeDirectory(path.dirname(payloadPath))) !==
        path.dirname(payloadPath)
      )
        throw new StorageFault('destination')
      if (!result.complete) throw new IncompleteFiles(result)
      return result
    }
    const candidate = structuredClone(stopped)
    candidate.saveDir = directory
    candidate.diskPath = target
    candidate.finalPath = target
    candidate.finalName = name
    candidate.filename = name
    if (request.mode !== 'recheck') candidate.name = name
    candidate.status = TaskStatus.Completed
    candidate.progress = 1
    candidate.downloadedBytes = candidate.totalBytes
    candidate.sizeWhenDone = candidate.totalBytes
    candidate.transitionPhase = TransitionPhase.Idle
    candidate.errorCode = null
    candidate.errorMessage = null
    candidate.errorDetailKey = null
    candidate.errorDetailParams = null
    candidate.updatedAt = Date.now()
    syncTerminalInstanceStatus(candidate, TaskStatus.Completed)
    const primary = pickPrimaryInstance(candidate.instances)
    if (!primary) throw new StorageFault('unavailable')
    primary.diskPath = target
    primary.transitionPhase = TransitionPhase.Idle
    primary.payload = {
      ...primary.payload,
      ...btStoragePayload({
        version: 2,
        strategy: 'direct',
        torrentRootName: layout.torrentRootName,
        multiFile: layout.multiFile,
        finalized: true,
      }),
    }
    // Failed output reservations are not permissions to delete earlier locations.
    delete primary.payload.btOutputReservation
    delete primary.payload.btOutputReservations
    let verification!: BtVerificationResult
    try {
      if (request.mode === 'move') {
        await deps.runtime.commit({
          task: candidate,
          occurrence: null,
          sourcePath: source,
          targetPath: target,
          metadataOps: [],
          contributors: [],
          postDeliveries: [],
          fileRebase: { sourceRoot: sourcePath, targetRoot: target },
          verifySource: async () => {
            verification = await verify(source)
            running.controller.signal.throwIfAborted()
            running.cancellable = false
            progress('moving')
          },
          onCommitted: () =>
            deps.taskManager.set(candidate.id, structuredClone(candidate)),
        })
      } else {
        await deps.runtime.withArtifactLease(stopped.id, async () => {
          verification = await verify(target)
          running.controller.signal.throwIfAborted()
          running.cancellable = false
          await deps.persistStorage(candidate, sourcePath, target)
        })
      }
    } catch (error) {
      if (!(error instanceof IncompleteFiles)) throw error
      if (request.mode === 'recheck') {
        const failed = structuredClone(stopped)
        failed.status = TaskStatus.Error
        syncTerminalInstanceStatus(failed, TaskStatus.Error)
        failed.errorCode = DownloadErrorCode.ChecksumMismatch
        failed.errorDetailKey = 'task.storage.incomplete'
        failed.errorDetailParams = null
        await deps.persistStorage(failed, sourcePath, sourcePath)
        deps.publishTaskUpdateNow()
      }
      return {
        taskId: stopped.id,
        path: sourcePath,
        verification: error.verification,
        resumed: false,
      }
    }
    deps.eventBus.emit(Events.TaskFilesUpdated, { taskId: candidate.id })
    deps.publishTaskUpdateNow()
    const result: BtStorageResult = {
      taskId: candidate.id,
      path: target,
      verification,
      resumed: false,
    }
    if (request.resume) {
      progress('resuming')
      try {
        await reAddTask(candidate.id, deps)
        result.resumed = true
      } catch (error) {
        deps.log.warn(
          { taskId: candidate.id, error },
          'BT storage changed but resuming failed'
        )
        result.resumeFailed = true
      }
    }
    return result
  }
}

/** Desktop canonicalizes selected parent aliases; Server supplies its policy instead. */
export async function authorizeBtDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory) || directory.includes('\0'))
    throw new StorageFault('destination')
  const canonical = await realpath(directory)
  if (!(await lstat(canonical)).isDirectory())
    throw new StorageFault('destination')
  return canonical
}
