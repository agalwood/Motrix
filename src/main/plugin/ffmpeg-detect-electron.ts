// ffmpeg-detect-electron — Electron shell factory for ffmpeg detection.
//
// Builds a closure that reads the live MediaSettings.ffmpegBinaryPath on every
// invocation (so toggling the setting takes effect without restarting the
// detector), derives the userData binaries dir from the caller-provided
// userDataDir, and delegates to detectInOrder. The wrapper itself does NOT
// import electron — the caller (main/index.ts) passes app.getPath('userData').
//
// Returns the enriched FfmpegDetectionResult; capability-host projects it down
// to the legacy FfmpegDetection shape consumed by FfmpegCapabilityHost.

import path from 'node:path'
import {
  detectInOrder,
  type FfmpegDetectionResult,
} from '@core/plugin/capabilities/ffmpeg-detect'
import type { SettingsManager } from '@core/settings/settings-manager'

export interface ElectronFfmpegDetectOptions {
  settingsManager: SettingsManager
  /** Caller-provided. Electron's app.getPath('userData'). The wrapper itself does NOT import electron. */
  userDataDir: string
}

export function makeElectronFfmpegDetect(
  opts: ElectronFfmpegDetectOptions
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
