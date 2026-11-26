import path from 'node:path'
import type { Aria2TaskStatus } from '@core/engine/aria2/types'
import { sanitizeFinalizeFilename } from '@core/fs/finalize-path'
import type { DownloadTask, TaskInstance } from '@shared/types/task'
import { TaskKind, TaskStatus, TaskType } from '@shared/types/task'
import {
  getBtDirectStorageLayout,
  getBtStorageLayout,
} from './bt-storage-layout'

export interface DirectMagnetIdentityPatch {
  name: string
  filename: string
  finalName: string
  finalPath: string
  diskPath: string
}

/**
 * 判断任务是否仍处于“未解析出真实种子名与落盘路径”的直连磁力占位状态。
 * 直连磁力在创建阶段不知晓真实种子结构，因此以 finalName=''、diskPath=''、
 * finalPath=saveDir 占位；一旦真实 BT 子任务元数据就绪，必须回填这组字段，
 * 否则任务名会停留在 infoHash 且 finalizeBt 无法命中原地收尾逻辑 (#2569)。
 */
export function needsDirectMagnetIdentityResolution(
  task: Pick<
    DownloadTask,
    | 'kind'
    | 'type'
    | 'saveDir'
    | 'finalName'
    | 'diskPath'
    | 'finalPath'
    | 'instances'
  >
): boolean {
  if (task.kind !== TaskKind.Bt && task.type !== TaskType.Magnet) return false
  if (!task.saveDir) return false
  if (getBtStorageLayout(task)) return false
  const directLayout = getBtDirectStorageLayout(task)
  if (directLayout?.torrentRootName) return false
  return !task.finalName || !task.diskPath || task.finalPath === task.saveDir
}

/**
 * 判断候选名称是否为磁力元数据阶段或未解析占位名。
 */
export function isMagnetPlaceholderName(
  name: string,
  options?: { infoHash?: string | null; engineTaskId?: string | null }
): boolean {
  const trimmed = name.trim()
  if (!trimmed) return true
  if (options?.engineTaskId && trimmed === options.engineTaskId) return true
  if (/^\[METADATA\]/i.test(trimmed)) return true
  if (/^magnet:/i.test(trimmed)) return true
  const normalizedHash = options?.infoHash?.trim().toLowerCase()
  if (normalizedHash && trimmed.toLowerCase() === normalizedHash) return true
  return false
}

/**
 * 从 aria2 原始状态行提取真实 BT 顶层名称（单文件为文件名，多文件为根目录名）。
 * 优先读取 bittorrent.info.name，缺失时在已有真实文件大小的情况下退回首文件路径的首段目录/文件名。
 */
export function extractResolvedBtNameFromRaw(
  raw: Aria2TaskStatus | undefined
): string | null {
  if (!raw) return null
  const infoName = raw.bittorrent?.info?.name?.trim()
  if (
    infoName &&
    infoName !== raw.gid &&
    !/^\[METADATA\]/i.test(infoName) &&
    !/^magnet:/i.test(infoName)
  ) {
    return infoName
  }

  const firstFilePath =
    'fileMetadata' in raw
      ? raw.fileMetadata.firstFile?.path
      : raw.files?.[0]?.path
  if (firstFilePath && raw.dir && Number(raw.totalLength) > 0) {
    const relative = path.relative(raw.dir, firstFilePath)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      const rootComponent = relative.split(/[\\/]/)[0]?.trim()
      if (
        rootComponent &&
        rootComponent !== '.' &&
        rootComponent !== '..' &&
        !/^\[METADATA\]/i.test(rootComponent)
      ) {
        return rootComponent
      }
    }
  }

  return null
}

/**
 * 从已翻译的引擎任务快照中提取真实 BT 名称，严格过滤元数据拉取阶段的占位名称。
 */
export function extractResolvedBtNameFromTask(
  engineTask: Pick<
    DownloadTask,
    | 'name'
    | 'engineTaskId'
    | 'status'
    | 'bt'
    | 'totalBytes'
    | 'fileCount'
    | 'infoHash'
  >,
  existingInfoHash?: string | null
): string | null {
  if (engineTask.status === TaskStatus.FetchingMetadata) return null
  if (
    !engineTask.bt &&
    engineTask.totalBytes === 0 &&
    engineTask.fileCount === 0
  ) {
    return null
  }
  const candidate = engineTask.name.trim()
  if (!candidate) return null
  if (candidate === engineTask.engineTaskId) return null
  if (/^\[METADATA\]/i.test(candidate) || /^magnet:/i.test(candidate)) {
    return null
  }
  // 尚未获得任何文件列表或大小时，与 infoHash 同名的条目仍属于占位名
  if (
    engineTask.totalBytes === 0 &&
    engineTask.fileCount === 0 &&
    isMagnetPlaceholderName(candidate, {
      infoHash: existingInfoHash ?? engineTask.infoHash,
      engineTaskId: engineTask.engineTaskId,
    })
  ) {
    return null
  }
  return candidate
}

/**
 * 基于已解析的真实种子顶层名称，生成与 aria2 实际落盘位置一致的任务标识与路径补丁。
 */
export function buildDirectMagnetIdentityPatch(
  existing: Pick<DownloadTask, 'saveDir'>,
  rawName: string,
  overrideSaveDir?: string
): DirectMagnetIdentityPatch | null {
  const saveDir = existing.saveDir || overrideSaveDir || ''
  const trimmed = rawName.trim()
  if (!saveDir || !trimmed) return null
  const safeName = sanitizeFinalizeFilename(trimmed)
  const resolvedPath = path.join(saveDir, safeName)
  return {
    name: safeName,
    filename: safeName,
    finalName: safeName,
    finalPath: resolvedPath,
    diskPath: resolvedPath,
  }
}

/**
 * 以不可变方式更新目标 GID 对应实例的 diskPath，避免原地修改 taskManager 中的活跃实例。
 */
export function applyDirectMagnetDiskPathToInstances(
  instances: readonly TaskInstance[],
  targetGid: string,
  diskPath: string
): TaskInstance[] {
  let matched = false
  const updated = instances.map((instance) => {
    if (instance.gid === targetGid) {
      matched = true
      return { ...instance, diskPath }
    }
    return { ...instance }
  })
  if (!matched && updated.length > 0) {
    updated[0] = { ...updated[0], diskPath }
  }
  return updated
}
