import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadTask } from '@shared/types/task'

/**
 * 将用户选定或配置的保存目录规范化为真实物理路径（realpath）。
 * 仅对已存在的目录祖先调用 realpath，再拼回尚未创建的子目录片段；
 * 这样在 macOS 等平台上把 ~/Downloads 软链到外置磁盘或数据卷时，
 * 后续 finalize-fs 的逐级 O_NOFOLLOW 安全校验不会把用户的合法保存目录误判为不安全路径。
 */
export async function canonicalizeSaveDir(requested: string): Promise<string> {
  const trimmed = requested.trim()
  if (!trimmed || !path.isAbsolute(trimmed)) return requested

  const resolved = path.resolve(trimmed)
  let ancestor = resolved
  const pendingSegments: string[] = []

  for (;;) {
    try {
      const info = await stat(ancestor)
      if (!info.isDirectory()) return requested
      const realAncestor = await realpath(ancestor)
      return pendingSegments.length > 0
        ? path.join(realAncestor, ...pendingSegments)
        : realAncestor
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return requested
      }
      const parent = path.dirname(ancestor)
      if (parent === ancestor) return requested
      pendingSegments.unshift(path.basename(ancestor))
      ancestor = parent
    }
  }
}

function rebasePathUnderRoot(
  candidate: string,
  fromRoot: string,
  toRoot: string
): string {
  const resolvedCandidate = path.resolve(candidate)
  if (resolvedCandidate === fromRoot) return toRoot
  const relative = path.relative(fromRoot, resolvedCandidate)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return candidate
  }
  // 仅替换已显式绑定的 saveDir 前缀，绝不对 saveDir 内部的子路径做 realpath，
  // 确保下游 finalize-fs 的 O_NOFOLLOW 仍严格拦截内部子目录或文件名的符号链接逃逸。
  return path.join(toRoot, relative)
}

export interface FinalizeCommitPathInput {
  task: DownloadTask
  sourcePath: string
  targetPath: string
  fileRebase?: {
    sourceRoot: string
    targetRoot: string
  }
}

/**
 * 为存量任务在落盘前将指向符号链接的 saveDir 根路径映射到其真实目录，
 * 同时保持 saveDir 内部相对路径不变以保留下游的符号链接逃逸防护。
 */
export async function canonicalizeFinalizeCommitRequest<
  T extends FinalizeCommitPathInput,
>(input: T): Promise<T> {
  const originalSaveDir = input.task.saveDir
  if (!originalSaveDir || !path.isAbsolute(originalSaveDir)) return input

  const resolvedSaveDir = path.resolve(originalSaveDir)
  const canonicalSaveDir = await canonicalizeSaveDir(originalSaveDir)
  if (canonicalSaveDir === resolvedSaveDir) return input

  const rebase = (p: string) =>
    rebasePathUnderRoot(p, resolvedSaveDir, canonicalSaveDir)

  const task = structuredClone(input.task)
  task.saveDir = canonicalSaveDir
  if (task.diskPath) task.diskPath = rebase(task.diskPath)
  if (task.finalPath) task.finalPath = rebase(task.finalPath)
  if (task.instances?.length) {
    for (const instance of task.instances) {
      if (instance.diskPath) instance.diskPath = rebase(instance.diskPath)
    }
  }

  return {
    ...input,
    task,
    sourcePath: rebase(input.sourcePath),
    targetPath: rebase(input.targetPath),
    ...(input.fileRebase
      ? {
          fileRebase: {
            sourceRoot: rebase(input.fileRebase.sourceRoot),
            targetRoot: rebase(input.fileRebase.targetRoot),
          },
        }
      : {}),
  }
}
