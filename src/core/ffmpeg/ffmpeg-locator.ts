import {
  type FfmpegDetectionInput,
  ffmpegCandidatesInOrder,
} from '@core/plugin/capabilities/ffmpeg-detect'

export interface FfmpegLocation {
  available: boolean
  binaryPath: string | null
  version: string | null
}

export type ResolveExecutable = (candidate: string) => Promise<string | null>

/**
 * Locate the first executable FFmpeg candidate without running it.
 *
 * This is intentionally different from the explicit Settings detector, which
 * executes `ffmpeg -version` to report a verified version. Startup callers
 * must use this non-executing locator so quarantined user-provided binaries do
 * not trigger an operating-system security prompt before they are used.
 */
export async function locateFfmpeg(
  input: FfmpegDetectionInput,
  resolveExecutable: ResolveExecutable
): Promise<FfmpegLocation> {
  for (const candidate of ffmpegCandidatesInOrder(input)) {
    if (!candidate.path) continue
    // eslint-disable-next-line no-await-in-loop
    const binaryPath = await resolveExecutable(candidate.path)
    if (binaryPath) {
      return { available: true, binaryPath, version: null }
    }
  }
  return { available: false, binaryPath: null, version: null }
}
