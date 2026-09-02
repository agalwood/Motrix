// src/core/plugin/hooks/staging-dir.ts
// Transparent ffmpeg output-path redirection into an isolated staging dir
// for the beforeFinalize hook phase. On chain commit the host promotes one
// staged file to the real saveDir; any remaining staged files are discarded.
//
// Architecture: stays inside src/core/ — no electron, no @main/, no @server/.

import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'

export interface StagingOptions {
  pluginsDir: string
  taskId: string
  pluginId: string
  saveDir: string
  quotaBytes: number // e.g. 4 * 1024 ** 3 (4 GiB)
}

export class FfmpegStaging {
  private readonly mappings = new Map<string, string>()

  constructor(private readonly opts: StagingOptions) {}

  get dir(): string {
    return path.join(
      this.opts.pluginsDir,
      this.opts.pluginId,
      'staging',
      this.opts.taskId
    )
  }

  /**
   * Redirect a user-supplied output path that resolves under saveDir into
   * the staging directory. Paths that land outside saveDir are passed through
   * unchanged so the plugin retains full control over non-saveDir outputs.
   *
   * saveDir trailing slashes are normalised so `/tmp/save/` and `/tmp/save`
   * behave identically.
   */
  redirectOutput(userOutput: string): string {
    const saveDir = this.opts.saveDir.replace(/[/\\]+$/, '')
    const resolved = path.resolve(saveDir, userOutput)
    if (!resolved.startsWith(saveDir + path.sep) && resolved !== saveDir) {
      return userOutput // not saveDir-bound; pass through unchanged
    }
    const rel = path.relative(saveDir, resolved)
    const stagedPath = path.join(this.dir, rel)
    this.mappings.set(resolved, stagedPath)
    return stagedPath
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  async assertQuota(): Promise<void> {
    let total = 0
    const entries = await readdir(this.dir, {
      recursive: true,
      withFileTypes: true,
    })
    for (const e of entries) {
      if (e.isFile()) {
        total += (await stat(path.join(e.parentPath, e.name))).size
      }
    }
    if (total > this.opts.quotaBytes) {
      throw new AppError(
        ErrorCode.PluginRuntimeFault,
        'plugin.ffmpeg.staging_quota_exceeded'
      )
    }
  }

  mappedArtifact(finalFilePath: string): string | undefined {
    const saveDir = this.opts.saveDir.replace(/[/\\]+$/, '')
    return this.mappings.get(path.resolve(saveDir, finalFilePath))
  }

  async discard(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
  }

  /**
   * Legacy startup cleanup is deliberately fail-closed. Finalize staging may
   * be referenced by a durable journal and must be recovered by the finalize
   * recovery service after identity verification.
   */
  static async cleanupOrphans(pluginsDir: string): Promise<void> {
    await readdir(pluginsDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return []
    })
  }
}
