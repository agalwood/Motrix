import type { Aria2TaskStatus } from '@core/engine/aria2/types'
import {
  buildDirectMagnetIdentityPatch,
  extractResolvedBtNameFromRaw,
  isMagnetPlaceholderName,
  needsDirectMagnetIdentityResolution,
} from '@core/task/direct-magnet-identity'
import type { TaskManager } from '@core/task/task-manager'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'

export interface MagnetFollowReconcileDeps {
  taskManager: Pick<
    TaskManager,
    'getByEngineTaskId' | 'getById' | 'set' | 'isEngineTaskIdRetired'
  >
  persistTask: (task: DownloadTask) => Promise<void>
  retireMetadataGid: (gid: string) => void
  /**
   * 当 followedBy 对应的真实 BT 子任务不在当前轮询批次中（例如由
   * aria2.onDownloadComplete 单条通知触发）时，主动查询子任务状态以即时拿到种子名。
   */
  lookupFollowedTask?: (gid: string) => Promise<Aria2TaskStatus | null>
  log: {
    info(context: Record<string, unknown>, message: string): void
    warn(context: Record<string, unknown>, message: string): void
  }
}

export interface MagnetFollowReconcileResult {
  skippedGids: Set<string>
  dirty: boolean
}

/**
 * 判断 aria2 状态行是否为已完成并自动跟进到真实 BT 子任务的磁力元数据阶段。
 * 直连磁力下载时 aria2 会先完成元数据 GID 并在 followedBy 中给出实际下载 GID，
 * 若不接力会导致旧的哈希命名磁力任务残留，且新 GID 被重复认领为第二个任务 (#2552)。
 */
export function isFollowedMagnetMetadata(raw: Aria2TaskStatus): boolean {
  return (
    raw.status === 'complete' &&
    Array.isArray(raw.followedBy) &&
    raw.followedBy.some((gid) => typeof gid === 'string' && gid !== raw.gid)
  )
}

export function getFollowedBtGid(raw: Aria2TaskStatus): string | null {
  if (!isFollowedMagnetMetadata(raw)) return null
  return (
    raw.followedBy?.find((gid) => typeof gid === 'string' && gid !== raw.gid) ??
    null
  )
}

function buildReboundMagnetTask(
  existing: DownloadTask,
  oldGid: string,
  nextGid: string,
  followedRaw: Aria2TaskStatus | undefined,
  now: number
): DownloadTask {
  const resolvedName = extractResolvedBtNameFromRaw(followedRaw)
  const shouldAdoptIdentity =
    Boolean(resolvedName) &&
    (needsDirectMagnetIdentityResolution(existing) ||
      isMagnetPlaceholderName(existing.name, {
        infoHash: existing.infoHash,
        engineTaskId: existing.engineTaskId,
      }))
  const identityPatch =
    shouldAdoptIdentity && resolvedName
      ? buildDirectMagnetIdentityPatch(existing, resolvedName, followedRaw?.dir)
      : null
  const nextDiskPath = identityPatch
    ? identityPatch.diskPath
    : existing.diskPath

  const instances = existing.instances.map((instance) =>
    instance.gid === oldGid
      ? {
          ...instance,
          gid: nextGid,
          diskPath: nextDiskPath,
          status:
            instance.status === TaskStatus.Completed
              ? TaskStatus.Downloading
              : instance.status,
          updatedAt: now,
        }
      : { ...instance }
  )

  return {
    ...existing,
    engineTaskId: nextGid,
    ...(identityPatch ?? {}),
    infoHash: followedRaw?.infoHash || existing.infoHash,
    status:
      existing.status === TaskStatus.Completed
        ? TaskStatus.Downloading
        : existing.status,
    finishedAt:
      existing.status === TaskStatus.Completed ? null : existing.finishedAt,
    instances,
    updatedAt: now,
  }
}

/**
 * 在常规轮询合并前先处理已完成的磁力元数据 followedBy 接力：
 * 1. 若原元数据 GID 对应已登记任务，则原地将其绑定到真实 BT GID 并更新占位名；
 * 2. 将原元数据 GID 放入 skippedGids 并清理引擎历史，避免重复任务与残留哈希任务。
 */
export async function reconcileFollowedMagnetTasks(
  rawTasks: readonly Aria2TaskStatus[],
  deps: MagnetFollowReconcileDeps,
  now = Date.now()
): Promise<MagnetFollowReconcileResult> {
  const skippedGids = new Set<string>()
  let dirty = false
  const rawByGid = new Map<string, Aria2TaskStatus>()
  for (const raw of rawTasks) {
    rawByGid.set(raw.gid, raw)
  }

  for (const raw of rawTasks) {
    const nextGid = getFollowedBtGid(raw)
    if (!nextGid) continue
    if (deps.taskManager.isEngineTaskIdRetired(raw.gid)) {
      skippedGids.add(raw.gid)
      continue
    }

    skippedGids.add(raw.gid)
    const existing = deps.taskManager.getByEngineTaskId(raw.gid)
    if (existing) {
      const nextOwner = deps.taskManager.getByEngineTaskId(nextGid)
      if (!nextOwner || nextOwner.id === existing.id) {
        let followedRaw = rawByGid.get(nextGid)
        if (!followedRaw && deps.lookupFollowedTask) {
          try {
            followedRaw = (await deps.lookupFollowedTask(nextGid)) ?? undefined
          } catch (err) {
            deps.log.warn(
              { err, taskId: existing.id, fromGid: raw.gid, toGid: nextGid },
              'failed to lookup followed BT task during magnet rebind'
            )
          }
        }
        const rebound = buildReboundMagnetTask(
          existing,
          raw.gid,
          nextGid,
          followedRaw,
          now
        )
        try {
          await deps.persistTask(rebound)
          if (deps.taskManager.getById(existing.id) === existing) {
            deps.taskManager.set(existing.id, rebound)
            dirty = true
            deps.log.info(
              {
                taskId: existing.id,
                fromGid: raw.gid,
                toGid: nextGid,
                name: rebound.name,
              },
              'rebound direct magnet task to followed BT gid'
            )
          }
        } catch (err) {
          deps.log.warn(
            { err, taskId: existing.id, fromGid: raw.gid, toGid: nextGid },
            'failed to persist followed magnet gid rebind'
          )
          // 持久化失败时保留下次轮询重试机会，但本次仍跳过避免误把元数据标为已完成
          continue
        }
      }
    }

    deps.retireMetadataGid(raw.gid)
  }

  return { skippedGids, dirty }
}
