import fs from 'node:fs/promises'
import path from 'node:path'
import { INCOMPLETE_SUFFIX } from '@shared/constants/incomplete'

export type DirectRecoveryKind =
  | 'finalization-candidate'
  | 'fresh'
  | 'checkpoint'
  | 'blocked'
  | 'invalid'

export type DirectRecoveryReason =
  | 'final-file-present'
  | 'temp-file-missing'
  | 'temp-file-empty'
  | 'checkpoint-present'
  | 'checkpoint-missing'
  | 'final-path-conflict'
  | 'path-missing'
  | 'path-contains-nul'
  | 'path-not-absolute'
  | 'filename-empty'
  | 'final-path-contains-nul'
  | 'final-path-not-absolute'
  | 'temp-path-not-file'
  | 'final-path-not-file'
  | 'checkpoint-path-not-file'
  | 'file-probe-failed'

export interface DirectRecoveryPrimary {
  diskPath?: string | null
}

export interface DirectRecoveryInput {
  primary?: DirectRecoveryPrimary | null
  finalPath?: string | null
}

export interface DirectRecoveryPlan {
  kind: DirectRecoveryKind
  reason: DirectRecoveryReason
  diskPath: string | null
  saveDir: string | null
  filename: string | null
  checkpointPath: string | null
  bytesBefore: number
  diskPathSource: 'primary' | 'final-path' | null
}

export interface DirectRecoveryFileStat {
  size: number
  isFile: boolean
}

export interface DirectRecoveryFileSystem {
  stat(filePath: string): Promise<DirectRecoveryFileStat | null>
}

export interface DirectRecoveryPath {
  isAbsolute(filePath: string): boolean
  dirname(filePath: string): string
  basename(filePath: string): string
}

const nodeFileSystem: DirectRecoveryFileSystem = {
  async stat(filePath) {
    try {
      const stat = await fs.stat(filePath)
      return { size: stat.size, isFile: stat.isFile() }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null
      }
      throw error
    }
  },
}

interface ResolvedOutput {
  diskPath: string
  saveDir: string
  filename: string
  checkpointPath: string
  diskPathSource: 'primary' | 'final-path'
}

export class DirectRecoveryPlanner {
  constructor(
    private readonly fileSystem: DirectRecoveryFileSystem = nodeFileSystem,
    private readonly pathApi: DirectRecoveryPath = path
  ) {}

  async plan(input: DirectRecoveryInput): Promise<DirectRecoveryPlan> {
    const resolved = this.resolveOutput(input)
    if ('invalid' in resolved) {
      return this.invalid(resolved.invalid)
    }

    const finalPath = input.finalPath || null

    try {
      const [tempStat, finalStat] = await Promise.all([
        this.fileSystem.stat(resolved.diskPath),
        finalPath ? this.fileSystem.stat(finalPath) : Promise.resolve(null),
      ])

      if (tempStat && !tempStat.isFile) {
        return this.result(resolved, 'invalid', 'temp-path-not-file', 0)
      }
      if (finalStat && !finalStat.isFile) {
        return this.result(resolved, 'invalid', 'final-path-not-file', 0)
      }

      if (!tempStat && finalStat) {
        return this.result(
          resolved,
          'finalization-candidate',
          'final-file-present',
          finalStat.size
        )
      }

      if (tempStat && finalStat) {
        return this.result(
          resolved,
          'blocked',
          'final-path-conflict',
          tempStat.size
        )
      }

      if (!tempStat) {
        return this.result(resolved, 'fresh', 'temp-file-missing', 0)
      }

      if (tempStat.size === 0) {
        return this.result(resolved, 'fresh', 'temp-file-empty', 0)
      }

      const checkpointStat = await this.fileSystem.stat(resolved.checkpointPath)
      if (checkpointStat && !checkpointStat.isFile) {
        return this.result(
          resolved,
          'invalid',
          'checkpoint-path-not-file',
          tempStat.size
        )
      }
      if (checkpointStat) {
        return this.result(
          resolved,
          'checkpoint',
          'checkpoint-present',
          tempStat.size
        )
      }
      return this.result(
        resolved,
        'blocked',
        'checkpoint-missing',
        tempStat.size
      )
    } catch {
      return this.result(resolved, 'invalid', 'file-probe-failed', 0)
    }
  }

  private resolveOutput(
    input: DirectRecoveryInput
  ): ResolvedOutput | { invalid: DirectRecoveryReason } {
    const primaryDiskPath = input.primary?.diskPath || null
    const finalPath = input.finalPath || null
    const diskPath =
      primaryDiskPath ?? (finalPath ? `${finalPath}${INCOMPLETE_SUFFIX}` : null)

    if (!diskPath) return { invalid: 'path-missing' }
    if (diskPath.includes('\0')) return { invalid: 'path-contains-nul' }
    if (!this.pathApi.isAbsolute(diskPath)) {
      return { invalid: 'path-not-absolute' }
    }
    if (finalPath?.includes('\0')) {
      return { invalid: 'final-path-contains-nul' }
    }
    if (finalPath && !this.pathApi.isAbsolute(finalPath)) {
      return { invalid: 'final-path-not-absolute' }
    }

    const filename = this.pathApi.basename(diskPath)
    if (!filename) return { invalid: 'filename-empty' }

    return {
      diskPath,
      saveDir: this.pathApi.dirname(diskPath),
      filename,
      checkpointPath: `${diskPath}.aria2`,
      diskPathSource: primaryDiskPath ? 'primary' : 'final-path',
    }
  }

  private result(
    resolved: ResolvedOutput,
    kind: DirectRecoveryKind,
    reason: DirectRecoveryReason,
    bytesBefore: number
  ): DirectRecoveryPlan {
    return {
      kind,
      reason,
      ...resolved,
      bytesBefore,
    }
  }

  private invalid(reason: DirectRecoveryReason): DirectRecoveryPlan {
    return {
      kind: 'invalid',
      reason,
      diskPath: null,
      saveDir: null,
      filename: null,
      checkpointPath: null,
      bytesBefore: 0,
      diskPathSource: null,
    }
  }
}
