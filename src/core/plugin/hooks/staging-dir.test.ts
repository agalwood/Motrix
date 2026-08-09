// src/core/plugin/hooks/staging-dir.test.ts

import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import { FfmpegStaging } from './staging-dir'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mbr-staging-'))
}

function makeStaging(
  pluginsDir: string,
  saveDir: string,
  overrides: Partial<{
    taskId: string
    pluginId: string
    quotaBytes: number
  }> = {}
): FfmpegStaging {
  return new FfmpegStaging({
    pluginsDir,
    taskId: overrides.taskId ?? 'task-abc',
    pluginId: overrides.pluginId ?? 'test.plugin',
    saveDir,
    quotaBytes: overrides.quotaBytes ?? 4 * 1024 ** 3,
  })
}

// ---------------------------------------------------------------------------
// redirectOutput
// ---------------------------------------------------------------------------

describe('FfmpegStaging.redirectOutput', () => {
  it('redirects a relative output name under saveDir into staging', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    const staging = makeStaging(pluginsDir, saveDir)
    const result = staging.redirectOutput('out.mp4')
    expect(result).toBe(path.join(staging.dir, 'out.mp4'))
  })

  it('redirects a relative sub-path under saveDir', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    const staging = makeStaging(pluginsDir, saveDir)
    const result = staging.redirectOutput('subdir/x.mp4')
    expect(result).toBe(path.join(staging.dir, 'subdir', 'x.mp4'))
  })

  it('passes through an absolute path outside saveDir unchanged', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    const staging = makeStaging(pluginsDir, saveDir)
    const elsewhere = '/elsewhere/x.mp4'
    expect(staging.redirectOutput(elsewhere)).toBe(elsewhere)
  })

  it('handles trailing-slash saveDir correctly (still redirects)', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    // Construct with trailing slash
    const stagingWithSlash = new FfmpegStaging({
      pluginsDir,
      taskId: 'task-abc',
      pluginId: 'test.plugin',
      saveDir: `${saveDir}/`,
      quotaBytes: 4 * 1024 ** 3,
    })
    const result = stagingWithSlash.redirectOutput('out.mp4')
    expect(result).toBe(path.join(stagingWithSlash.dir, 'out.mp4'))
  })

  it('redirects an absolute path that resolves under saveDir', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    const staging = makeStaging(pluginsDir, saveDir)
    const absUnderSave = path.join(saveDir, 'out.mkv')
    const result = staging.redirectOutput(absUnderSave)
    expect(result).toBe(path.join(staging.dir, 'out.mkv'))
  })
})

// ---------------------------------------------------------------------------
// ensureDir
// ---------------------------------------------------------------------------

describe('FfmpegStaging.ensureDir', () => {
  it('creates the staging directory', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    const staging = makeStaging(pluginsDir, saveDir)
    await staging.ensureDir()
    const s = await stat(staging.dir)
    expect(s.isDirectory()).toBe(true)
  })

  it('is idempotent: calling ensureDir twice does not throw', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    const staging = makeStaging(pluginsDir, saveDir)
    await staging.ensureDir()
    await expect(staging.ensureDir()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

describe('FfmpegStaging.promote', () => {
  it('moves the staged file to saveDir and removes the staging dir', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    const staging = makeStaging(pluginsDir, saveDir)

    // Prepare the staged file
    await staging.ensureDir()
    const stagedContent = 'video-data'
    const stagedFile = path.join(staging.dir, 'out.mp4')
    await writeFile(stagedFile, stagedContent)

    const finalPath = path.join(saveDir, 'out.mp4')
    const promoted = await staging.promote(finalPath)

    expect(promoted).toBe(finalPath)

    // File is at the destination
    const destStat = await stat(finalPath)
    expect(destStat.isFile()).toBe(true)

    // Staging dir is gone
    await expect(stat(staging.dir)).rejects.toThrow()
  })

  it('throws ENOENT when the staged file does not exist', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    const staging = makeStaging(pluginsDir, saveDir)

    await staging.ensureDir()
    // Do NOT create the file

    const finalPath = path.join(saveDir, 'missing.mp4')
    await expect(staging.promote(finalPath)).rejects.toThrow(/ENOENT/)
  })

  it('removes staging dir even when there are no leftover files', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    const staging = makeStaging(pluginsDir, saveDir)

    await staging.ensureDir()
    const stagedFile = path.join(staging.dir, 'single.mp4')
    await writeFile(stagedFile, 'x')

    await staging.promote(path.join(saveDir, 'single.mp4'))
    // Staging root for this task is cleaned up
    await expect(stat(staging.dir)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// discard
// ---------------------------------------------------------------------------

describe('FfmpegStaging.discard', () => {
  it('removes the staging directory wholesale', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    const staging = makeStaging(pluginsDir, saveDir)

    await staging.ensureDir()
    await writeFile(path.join(staging.dir, 'a.mp4'), 'a')
    await writeFile(path.join(staging.dir, 'b.mp4'), 'b')

    await staging.discard()
    await expect(stat(staging.dir)).rejects.toThrow()
  })

  it('does not throw when called on a non-existent staging dir', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    const staging = makeStaging(pluginsDir, saveDir)

    // Never called ensureDir — dir does not exist
    await expect(staging.discard()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// cleanupOrphans
// ---------------------------------------------------------------------------

describe('FfmpegStaging.cleanupOrphans', () => {
  it('removes staging/ subdirs across multiple plugin ids', async () => {
    const pluginsDir = await makeTmpDir()

    // Create two plugin staging dirs with files
    for (const pluginId of ['plugin.a', 'plugin.b']) {
      const stagingRoot = path.join(pluginsDir, pluginId, 'staging', 'task-1')
      await mkdir(stagingRoot, { recursive: true })
      await writeFile(path.join(stagingRoot, 'out.mp4'), 'leftover')
    }

    await FfmpegStaging.cleanupOrphans(pluginsDir)

    for (const pluginId of ['plugin.a', 'plugin.b']) {
      const stagingRoot = path.join(pluginsDir, pluginId, 'staging')
      await expect(stat(stagingRoot)).rejects.toThrow()
    }

    // Plugin dirs themselves should still be present
    for (const pluginId of ['plugin.a', 'plugin.b']) {
      const pluginDir = path.join(pluginsDir, pluginId)
      const s = await stat(pluginDir)
      expect(s.isDirectory()).toBe(true)
    }
  })

  it('does not throw when pluginsDir does not exist (first-run scenario)', async () => {
    const nonexistent = path.join(tmpdir(), `mbr-noexist-${Date.now()}`)
    await expect(
      FfmpegStaging.cleanupOrphans(nonexistent)
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// assertQuota
// ---------------------------------------------------------------------------

describe('FfmpegStaging.assertQuota', () => {
  it('throws plugin.ffmpeg.staging_quota_exceeded when over budget', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    // Set a tiny quota of 10 bytes
    const staging = makeStaging(pluginsDir, saveDir, { quotaBytes: 10 })

    await staging.ensureDir()
    // Write 20 bytes — over the 10-byte quota
    await writeFile(path.join(staging.dir, 'big.mp4'), '12345678901234567890')

    const err = await staging.assertQuota().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    const appErr = err as AppError
    expect(appErr.code).toBe(ErrorCode.PluginRuntimeFault)
    expect(appErr.message).toBe('plugin.ffmpeg.staging_quota_exceeded')
  })

  it('passes silently when under budget', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    // Quota: 1 MiB, file: 100 bytes
    const staging = makeStaging(pluginsDir, saveDir, {
      quotaBytes: 1024 * 1024,
    })

    await staging.ensureDir()
    await writeFile(
      path.join(staging.dir, 'small.mp4'),
      Buffer.alloc(100, 0x42)
    )

    await expect(staging.assertQuota()).resolves.toBeUndefined()
  })

  it('counts files in subdirectories toward the quota', async () => {
    const pluginsDir = await makeTmpDir()
    const saveDir = await makeTmpDir()
    const staging = makeStaging(pluginsDir, saveDir, { quotaBytes: 30 })

    await staging.ensureDir()
    const subDir = path.join(staging.dir, 'sub')
    await mkdir(subDir)
    // 20 bytes in root + 20 bytes in sub = 40 bytes > 30 quota
    await writeFile(path.join(staging.dir, 'a.mp4'), '01234567890123456789')
    await writeFile(path.join(subDir, 'b.mp4'), '01234567890123456789')

    const err = await staging.assertQuota().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
  })
})

// ---------------------------------------------------------------------------
// dir getter
// ---------------------------------------------------------------------------

describe('FfmpegStaging.dir', () => {
  it('returns the expected path', () => {
    const staging = new FfmpegStaging({
      pluginsDir: '/plugins',
      taskId: 'task-1',
      pluginId: 'my.plugin',
      saveDir: '/save',
      quotaBytes: 1024,
    })
    expect(staging.dir).toBe(
      path.join('/plugins', 'my.plugin', 'staging', 'task-1')
    )
  })
})
