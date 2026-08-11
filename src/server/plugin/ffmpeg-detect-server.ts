// ffmpeg-detect-server — Node/Docker shell factory for ffmpeg detection.
//
// Builds a closure that reads the live MediaSettings.ffmpegBinaryPath on every
// invocation, derives the userData binaries dir from the caller-provided
// userDataDir, and delegates to detectInOrder. Does NOT import electron.
//
// Returns the enriched FfmpegDetectionResult; capability-host projects it down
// to the legacy FfmpegDetection shape consumed by FfmpegCapabilityHost.

import path from 'node:path'
import {
  detectInOrder,
  type FfmpegDetectionResult,
} from '@core/plugin/capabilities/ffmpeg-detect'
import type { SettingsManager } from '@core/settings/settings-manager'

export interface ServerFfmpegDetectOptions {
  settingsManager: SettingsManager
  /** Server-shell user data dir (lockbox + binaries + etc. live under here). */
  userDataDir: string
}

export function makeServerFfmpegDetect(
  opts: ServerFfmpegDetectOptions
): () => Promise<FfmpegDetectionResult> {
  const userDataBinariesDir = path.join(opts.userDataDir, 'binaries')
  return async () =>
    detectInOrder({
      manualPath: opts.settingsManager.get().media.ffmpegBinaryPath,
      userDataBinariesDir,
      platform: process.platform,
      envPath: process.env.MOTRIX_FFMPEG_PATH ?? null,
    })
}
