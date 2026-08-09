// src/core/plugin/hooks/staging-dir.ts
// Transparent ffmpeg output-path redirection into an isolated staging dir
// for the beforeFinalize hook phase. On chain commit the host promotes one
// staged file to the real saveDir; any remaining staged files are discarded.
//
// Architecture: stays inside src/core/ — no electron, no @main/, no @server/.

import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
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
    return path.join(this.dir, rel)
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

  /**
   * Chain commit: promote the file matching `finalFilePath` to saveDir; delete
   * all remaining staging contents afterward.
   *
   * `finalFilePath` may be absolute (resolving to saveDir) or relative to
   * saveDir. Returns the absolute path of the promoted file.
   */
  async promote(finalFilePath: string): Promise<string> {
    const saveDir = this.opts.saveDir.replace(/[/\\]+$/, '')
    const finalAbs = path.resolve(saveDir, finalFilePath)
    const stagedAbs = path.join(this.dir, path.relative(saveDir, finalAbs))
    const tmp = `${finalAbs}.tmp-${Date.now()}`
    await mkdir(path.dirname(finalAbs), { recursive: true })
    await rename(stagedAbs, tmp)
    await rename(tmp, finalAbs)
    await rm(this.dir, { recursive: true, force: true })
    return finalAbs
  }

  async discard(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
  }

  /**
   * Host startup: remove leftover staging/ subdirs across all plugins for
   * crash recovery. Runs once before any hook is dispatched.
   *
   * Ignores errors when pluginsDir does not exist (first run).
   */
  static async cleanupOrphans(pluginsDir: string): Promise<void> {
    try {
      for (const pluginId of await readdir(pluginsDir)) {
        const stagingRoot = path.join(pluginsDir, pluginId, 'staging')
        await rm(stagingRoot, { recursive: true, force: true })
      }
    } catch {
      // pluginsDir may not exist on first run — ignore
    }
  }
}
