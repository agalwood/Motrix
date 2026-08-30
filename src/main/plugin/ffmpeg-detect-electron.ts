// ffmpeg-detect-electron — Electron shell factory for ffmpeg detection.
//
// Builds a closure that reads the live MediaSettings.ffmpegBinaryPath on every
// invocation (so toggling the setting takes effect without restarting the
// detector), derives the userData binaries dir from the caller-provided
// userDataDir, and delegates to detectInOrder. The wrapper itself does NOT
// import electron — the caller (main/index.ts) passes app.getPath('userData').
//
// Returns the enriched FfmpegDetectionResult for explicit Settings checks.
// Startup uses the separate non-executing locator.

import path from 'node:path'
import {
  detectInOrder,
  type FfmpegDetectionResult,
} from '@core/plugin/capabilities/ffmpeg-detect'
import type { SettingsManager } from '@core/settings/settings-manager'
import { makeElectronFfmpegProbe } from './ffmpeg-probe-electron'

export interface ElectronFfmpegDetectOptions {
  settingsManager: SettingsManager
  /** Caller-provided. Electron's app.getPath('userData'). The wrapper itself does NOT import electron. */
  userDataDir: string
}

/**
 * Desktop builds document MOTRIX_FFMPEG_BIN. Keep the earlier
 * MOTRIX_FFMPEG_PATH spelling as a fallback for existing installations.
 */
export function resolveElectronFfmpegEnvPath(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  return env.MOTRIX_FFMPEG_BIN ?? env.MOTRIX_FFMPEG_PATH ?? null
}

export function makeElectronFfmpegDetect(
  opts: ElectronFfmpegDetectOptions
): () => Promise<FfmpegDetectionResult> {
  const userDataBinariesDir = path.join(opts.userDataDir, 'binaries')
  const probe = makeElectronFfmpegProbe()
  return async () =>
    detectInOrder(
      {
        manualPath: opts.settingsManager.get().media.ffmpegBinaryPath,
        userDataBinariesDir,
        platform: process.platform,
        envPath: resolveElectronFfmpegEnvPath(),
      },
      probe
    )
}
