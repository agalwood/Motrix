import { createHash } from 'node:crypto'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { TaskWithInstances } from '@core/session/motrix-database'
import { AppError, ErrorCode } from '@shared/errors'
import { legacyHttpActivationSchema } from '@shared/schemas/legacy-http-activation'
import { legacyTaskMetadataSchema } from '@shared/schemas/legacy-import'
import type { DownloadTask } from '@shared/types/task'
import { TaskInstancePhase, TaskType } from '@shared/types/task'

export {
  hasLegacyImport,
  isLegacyImportInactive as isInactiveLegacyTask,
} from '@shared/types/task-actions'

import {
  hasLegacyImport,
  isLegacyImportInactive as isInactiveLegacyTask,
} from '@shared/types/task-actions'

/** A magnet's display/output hint cannot establish file ownership before metadata exists. */
export function isUnresolvedLegacyMagnet({
  task,
  instances,
}: TaskWithInstances): boolean {
  const instance = instances[0]
  const payload = instance?.payload ?? {}
  if (
    task.taskType !== TaskType.Magnet ||
    task.torrentMetaPath ||
    instances.length !== 1 ||
    instance.gid ||
    instance.phase !== TaskInstancePhase.BtDownload ||
    Object.hasOwn(payload, 'legacyBtActivation') ||
    Object.hasOwn(payload, 'legacyHttpActivation')
  )
    return false
  const marker = legacyTaskMetadataSchema.safeParse(payload.legacyImport)
  return (
    marker.success &&
    marker.data.activation === 'inactive' &&
    marker.data.storagePolicy === 'legacy-read-only'
  )
}

export function assertLegacyTaskNotActivated(
  task: Pick<DownloadTask, 'instances'>
): void {
  if (isInactiveLegacyTask(task)) {
    throw new AppError(
      ErrorCode.EngineFeatureUnavailable,
      'legacyImport.activationRequired'
    )
  }
}

export function assertLegacyTaskNotRecreated(
  task: Pick<DownloadTask, 'instances'>
): void {
  if (hasLegacyImport(task))
    throw new AppError(
      ErrorCode.EngineFeatureUnavailable,
      'legacyImport.activationRequired'
    )
}

/** Pending or corrupt migration records quarantine every known reserved/bound GID. */
export function getLegacyQuarantinedGids(
  task: Pick<DownloadTask, 'instances'>
): Set<string> {
  const result = new Set<string>()
  if (!isInactiveLegacyTask(task)) return result
  for (const instance of task.instances ?? []) {
    if (instance.gid) result.add(instance.gid)
    for (const candidate of [
      instance.payload?.legacyBtActivation,
      instance.payload?.legacyHttpActivation,
    ]) {
      const activation = candidate as { engineTaskId?: unknown } | undefined
      if (
        typeof activation?.engineTaskId === 'string' &&
        /^[a-f0-9]{16}$/.test(activation.engineTaskId)
      )
        result.add(activation.engineTaskId)
    }
  }
  return result
}

/** Reconstruct only the validated identity needed to prove an engine binding. */
export function getLegacyHttpBindingInput(
  task: DownloadTask
): Parameters<NonNullable<EngineAdapter['verifyLegacyHttpBinding']>>[0] | null {
  if (task.type !== TaskType.Http || task.instances.length !== 1) return null
  const instance = task.instances[0]
  const parsed = legacyHttpActivationSchema.safeParse(
    instance.payload.legacyHttpActivation
  )
  if (!parsed.success || instance.phase !== TaskInstancePhase.HttpDownload)
    return null
  const intent = parsed.data
  const uri = instance.uris[0]
  if (
    instance.uris.length !== 1 ||
    !uri ||
    createHash('sha256').update(uri).digest('hex') !== intent.uriDigest ||
    (task.engineTaskId && task.engineTaskId !== intent.engineTaskId) ||
    task.diskPath !== intent.targetPath ||
    task.finalPath !== intent.targetPath
  )
    return null
  return {
    engineTaskId: intent.engineTaskId,
    saveDir: intent.saveDir,
    targetPath: intent.targetPath,
    uri,
    expected: {
      totalBytes: intent.expected.totalBytes,
      pieceBytes: intent.expected.pieceBytes,
    },
    entityTag: intent.resourceValidator.value,
    fileIdentity: {
      device: intent.files[0].identity.device,
      inode: intent.files[0].identity.inode,
    },
  }
}
